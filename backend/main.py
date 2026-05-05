import os
import asyncio
import base64
import json
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer
import warnings
warnings.filterwarnings("ignore", category=FutureWarning)
from groq import Groq, RateLimitError, APIStatusError, APIConnectionError
from dotenv import load_dotenv

load_dotenv()

# --- CONFIGURATION ---
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY environment variable is not set. Add it to backend/.env.")

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://neo4j:7687")
NEO4J_AUTH = (
    os.getenv("NEO4J_AUTH_USER", ""),
    os.getenv("NEO4J_AUTH_PASS", ""),
)

MAX_IMAGE_BYTES = 10 * 1024 * 1024   # 10 MB
MAX_AUDIO_BYTES = 25 * 1024 * 1024   # 25 MB
GROQ_TIMEOUT = 90.0                    # seconds per Groq API call

# Single place to change models. All three are env-configurable so you can swap
# without code changes when Groq deprecates or releases new models.
#   Text:   llama-3.3-70b-versatile                          — strong general-purpose
#   Vision: meta-llama/llama-4-scout-17b-16e-instruct        — current multimodal
#   Audio:  whisper-large-v3-turbo                           — fast speech-to-text
# (The earlier llama-3.2-*-vision-preview models were deprecated by Groq in 2025.)
GROQ_TEXT_MODEL = os.getenv("GROQ_TEXT_MODEL", "llama-3.3-70b-versatile")
GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
GROQ_AUDIO_MODEL = os.getenv("GROQ_AUDIO_MODEL", "whisper-large-v3-turbo")

app = FastAPI(title="SysOps AI Core")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading semantic embedding model (all-MiniLM-L6-v2)...")
text_model = SentenceTransformer('all-MiniLM-L6-v2')

# Module-level Groq client — reused across all requests.
groq_client = Groq(api_key=GROQ_API_KEY, timeout=GROQ_TIMEOUT)

# Module-level driver — long-lived and connection-pooled.
_driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)

# Load the known device names once at startup so we can do exact device detection.
try:
    with open("data/manuals.json", "r") as _f:
        _manuals = json.load(_f)
    KNOWN_DEVICES: list[str] = sorted(
        {item["device"] for item in _manuals if item.get("device")},
        key=lambda d: -len(d)
    )
except Exception:
    KNOWN_DEVICES = []
print(f"Loaded {len(KNOWN_DEVICES)} known device models for RAG matching.")


def extract_device_from_text(user_text: str) -> Optional[str]:
    """
    Returns the best-matching known device name using distinctive-word scoring.
    Each word is weighted by 1 / (number of devices that contain it), so a unique
    model word like "Catalyst" or "PowerEdge" scores 1.0 while a shared brand word
    like "Cisco" or "Dell" scores ~0.3–0.5. Threshold 0.75 accepts a single
    distinctive model word but rejects brand-only matches.
    """
    user_lower = user_text.lower()

    word_device_count: dict[str, int] = {}
    for device in KNOWN_DEVICES:
        for w in device.lower().split():
            if len(w) >= 3:
                word_device_count[w] = word_device_count.get(w, 0) + 1

    best_device, best_score = None, 0.0
    for device in KNOWN_DEVICES:
        words = [w for w in device.lower().split() if len(w) >= 3]
        score = sum(
            1.0 / word_device_count.get(w, 1)
            for w in words
            if w in user_lower
        )
        if score > best_score:
            best_score = score
            best_device = device

    return best_device if best_score >= 0.75 else None


def search_neo4j(search_vector, detected_device: Optional[str] = None, user_text: str = ""):
    if detected_device:
        device_query = """
        CALL db.index.vector.queryNodes('component_embeddings', 20, $embedding)
        YIELD node AS comp, score
        MATCH (dev:Device)-[:HAS_COMPONENT]->(comp)-[:HAS_RESOLUTION]->(res:Resolution)
        WHERE dev.name = $device_name
        RETURN dev.name AS device, comp.name AS component, res.text AS resolution,
               score, comp.image_url AS image_url
        ORDER BY score DESC
        LIMIT 1
        """
        with _driver.session() as session:
            records = session.run(
                device_query, embedding=search_vector, device_name=detected_device
            ).data()

        if records:
            rec = records[0]
            return {
                "device": rec["device"],
                "component": rec["component"],
                "resolution": rec["resolution"],
                "score": rec["score"],
                "image_url": rec["image_url"],
                "detected_device": detected_device,
            }

    generic_query = """
    CALL db.index.vector.queryNodes('component_embeddings', 5, $embedding)
    YIELD node AS comp, score
    MATCH (dev:Device)-[:HAS_COMPONENT]->(comp)-[:HAS_RESOLUTION]->(res:Resolution)
    RETURN dev.name AS device, comp.name AS component, res.text AS resolution,
           score, comp.image_url AS image_url
    """
    with _driver.session() as session:
        records = session.run(generic_query, embedding=search_vector).data()

    if not records:
        return None

    if user_text:
        user_lower = user_text.lower()
        for rec in records:
            device_words = [w.lower() for w in rec["device"].split() if len(w) >= 3]
            boost = 1.2 if any(w in user_lower for w in device_words) else 1.0
            rec["_rank"] = rec["score"] * boost
        records.sort(key=lambda r: r["_rank"], reverse=True)

    rec = records[0]
    return {
        "device": rec["device"],
        "component": rec["component"],
        "resolution": rec["resolution"],
        "score": rec["score"],
        "image_url": rec["image_url"],
        "detected_device": detected_device,
    }


def get_graph_data_from_db(component_name: Optional[str] = None, device_name: Optional[str] = None):
    """Return the subgraph relevant to a component and optionally restricted to a specific device."""
    if component_name and device_name:
        query = """
        MATCH (dev:Device {name: $device_name})-[r1:HAS_COMPONENT]->(comp:Component)
        OPTIONAL MATCH (comp)-[r2:HAS_RESOLUTION]->(res:Resolution)
        RETURN dev, r1, comp, r2, res
        """
    elif component_name:
        query = """
        MATCH (comp) WHERE comp.name = $component OR comp.issue = $component
        MATCH (n)-[r]-(m) WHERE n = comp OR m = comp
        RETURN n, r, m
        """
    else:
        query = "MATCH (n)-[r]->(m) RETURN n, r, m"

    nodes, links = [], []
    node_ids = set()

    try:
        with _driver.session() as session:
            if component_name and device_name:
                result = session.run(query, device_name=device_name, component=component_name)
                for record in result:
                    dev_node = record["dev"]
                    comp_node = record["comp"]
                    r1 = record["r1"]
                    res_node = record["res"]
                    r2 = record["r2"]

                    for node in [dev_node, comp_node, res_node]:
                        if node is None:
                            continue
                        if node.element_id not in node_ids:
                            label = list(node.labels)[0] if node.labels else "Unknown"
                            name = node.get("name") or node.get("issue") or "Unknown"
                            nodes.append({"id": node.element_id, "label": label, "name": name})
                            node_ids.add(node.element_id)

                    for rel in [r1, r2]:
                        if rel is None:
                            continue
                        links.append({
                            "source": rel.start_node.element_id,
                            "target": rel.end_node.element_id,
                            "label": rel.type
                        })
            else:
                result = session.run(query, component=component_name)
                for record in result:
                    n, m, r = record["n"], record["m"], record["r"]

                    if n.element_id not in node_ids:
                        label = list(n.labels)[0] if n.labels else "Unknown"
                        name = n.get("name") or n.get("issue") or "Unknown"
                        nodes.append({"id": n.element_id, "label": label, "name": name})
                        node_ids.add(n.element_id)

                    if m.element_id not in node_ids:
                        label = list(m.labels)[0] if m.labels else "Unknown"
                        name = m.get("name") or m.get("issue") or "Unknown"
                        nodes.append({"id": m.element_id, "label": label, "name": name})
                        node_ids.add(m.element_id)

                    links.append({
                        "source": n.element_id,
                        "target": m.element_id,
                        "label": r.type
                    })
        return {"nodes": nodes, "links": links}
    except Exception as e:
        return {"error": str(e)}


async def groq_call_with_retry(func, *args, **kwargs):
    """Run a blocking Groq SDK call in an executor with timeout, retry, and rate-limit translation."""
    loop = asyncio.get_running_loop()
    max_retries = 3
    for attempt in range(max_retries):
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(None, lambda: func(*args, **kwargs)),
                timeout=GROQ_TIMEOUT,
            )
        except (asyncio.TimeoutError, TimeoutError):
            raise
        except RateLimitError:
            # Don't retry — the per-minute window hasn't reset yet.
            raise HTTPException(
                status_code=429,
                detail=(
                    "Groq API rate limit reached. Please wait about 60 seconds and try again. "
                    "If this keeps happening, your daily token quota may be exhausted — "
                    "check usage at https://console.groq.com."
                ),
            )
        except (APIConnectionError, APIStatusError) as e:
            # Transient errors (network blip, 5xx) — retry with backoff.
            if attempt < max_retries - 1:
                await asyncio.sleep(2 * (attempt + 1))
            else:
                raise HTTPException(status_code=502, detail=f"Groq API error: {str(e)}")


def _image_data_url(image_bytes: bytes, image_extension: str) -> str:
    """Encode image bytes into a base64 data URL for inline submission to a vision model."""
    ext = (image_extension or ".jpg").lower().lstrip(".")
    mime = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "webp": "image/webp", "gif": "image/gif",
    }.get(ext, "image/jpeg")
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _convert_history_to_openai(gemini_history) -> list[dict]:
    """
    The frontend stores chat history in Gemini format
    ([{role, parts: [{text}]}]). Convert it to OpenAI/Groq format
    ([{role, content}]) so we don't have to change the frontend.
    Gemini role 'model' becomes 'assistant'.
    """
    out = []
    for msg in gemini_history:
        role = msg.get("role")
        if role == "model":
            role = "assistant"
        if role not in ("user", "assistant", "system"):
            continue
        parts = msg.get("parts", [])
        text = "".join(
            p.get("text", "")
            for p in parts
            if isinstance(p, dict)
        )
        if text.strip():
            out.append({"role": role, "content": text})
    return out


async def describe_image_for_search(image_bytes: bytes, image_extension: str) -> str:
    """
    Use Groq's vision model to produce a searchable text description of the
    device / hardware component / symptom shown in the image. Used for the
    Neo4j vector-search step when the image is the ONLY user input.
    """
    data_url = _image_data_url(image_bytes, image_extension)
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "You are a senior IT infrastructure engineer assisting with hardware "
                        "diagnostics. Examine this image and describe:\n"
                        "1. Which specific device, hardware component, or chassis part is visible "
                        "(e.g., switch port LED, server PSU, RAID controller, motherboard, "
                        "rack-mounted appliance, error code on a console screen)?\n"
                        "2. What visible symptoms or status indicators are present "
                        "(amber/red LED, error code on display, kernel panic on screen, physical damage)?\n"
                        "3. Which subsystem does this belong to "
                        "(compute, storage, network, power, cooling, management plane)?\n"
                        "Be concise and use precise IT/datacenter terminology. "
                        "This description will be used to search a vendor documentation knowledge base."
                    ),
                },
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    ]

    def _call():
        return groq_client.chat.completions.create(
            model=GROQ_VISION_MODEL,
            messages=messages,
            max_tokens=400,
            temperature=0.2,
        )

    response = await groq_call_with_retry(_call)
    return response.choices[0].message.content or ""


async def transcribe_audio_with_groq(audio_bytes: bytes, audio_extension: str) -> str:
    """
    Transcribe audio with Groq's hosted Whisper. Note: Whisper is speech-to-text
    only — it will NOT describe non-speech sounds like beep codes or alarm tones.
    For raw beep-code audio, the engineer should describe it in text instead.
    """
    filename = f"audio{audio_extension or '.mp3'}"

    def _call():
        return groq_client.audio.transcriptions.create(
            file=(filename, audio_bytes),
            model=GROQ_AUDIO_MODEL,
            response_format="text",
        )

    transcript = await groq_call_with_retry(_call)
    # Groq SDK returns a string when response_format="text"
    return (transcript or "").strip() if isinstance(transcript, str) else (
        getattr(transcript, "text", "") or ""
    ).strip()


@app.get("/health")
def health_check():
    try:
        with _driver.session() as session:
            session.run("RETURN 1")
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {str(e)}")


@app.get("/graph-data")
def get_graph_data(component: Optional[str] = None):
    return get_graph_data_from_db(component)


@app.post("/diagnose")
async def diagnose(
    image: Optional[UploadFile] = File(None),
    audio: Optional[UploadFile] = File(None),
    text_issue: Optional[str] = Form(None),
    chat_history: Optional[str] = Form("[]")
):
    try:
        history = json.loads(chat_history)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid chat_history: must be a valid JSON array.")

    try:
        loop = asyncio.get_running_loop()

        # 1. Read file bytes immediately
        image_bytes = await image.read() if image else None
        audio_bytes = await audio.read() if audio else None

        # 1a. Enforce file size limits before sending anything to Groq.
        if image_bytes and len(image_bytes) > MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Image too large. Maximum allowed size is {MAX_IMAGE_BYTES // (1024 * 1024)} MB."
            )
        if audio_bytes and len(audio_bytes) > MAX_AUDIO_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Audio file too large. Maximum allowed size is {MAX_AUDIO_BYTES // (1024 * 1024)} MB."
            )

        # 2. Image handling — Groq has no Files API, so we keep the bytes for inline base64.
        #    Only run a separate vision-describe call when the image is the SOLE input
        #    (we need a textual description for the Neo4j vector search).
        image_description = None
        image_data_url = None
        image_ext = None
        if image_bytes:
            image_ext = os.path.splitext(image.filename)[1] or ".jpg"
            image_data_url = _image_data_url(image_bytes, image_ext)
            if not text_issue and not audio_bytes:
                image_description = await describe_image_for_search(image_bytes, image_ext)

        # 3. Audio handling — always transcribe with Whisper for both vector search and prompt context.
        audio_transcript = None
        if audio_bytes:
            aud_ext = os.path.splitext(audio.filename)[1] or ".mp3"
            audio_transcript = await transcribe_audio_with_groq(audio_bytes, aud_ext)

        # 4. Database search — only runs on the first turn of a conversation.
        db_context = None
        subgraph_data = None

        if len(history) == 0:
            if not image_bytes and not text_issue and not audio_transcript:
                raise HTTPException(
                    status_code=400,
                    detail="Please provide an image, audio recording, or text description to start the diagnostic."
                )

            device_detect_text = " ".join(filter(None, [text_issue, audio_transcript]))
            detected_device = extract_device_from_text(device_detect_text) if device_detect_text else None

            all_context_text = " ".join(filter(None, [text_issue, audio_transcript, image_description]))
            if detected_device and all_context_text:
                device_words = set(w.lower() for w in detected_device.split())
                cleaned = [w for w in all_context_text.split() if w.lower() not in device_words]
                embed_text = " ".join(cleaned) if len(cleaned) >= 3 else all_context_text
            else:
                embed_text = all_context_text

            search_vector = await loop.run_in_executor(
                None, lambda: text_model.encode(embed_text).tolist()
            )
            db_context = await loop.run_in_executor(
                None, lambda: search_neo4j(
                    search_vector,
                    detected_device=detected_device,
                    user_text=device_detect_text,
                )
            )
            if not db_context:
                raise HTTPException(status_code=404, detail="No matching component found in the database.")

            subgraph_data = await loop.run_in_executor(
                None, lambda: get_graph_data_from_db(
                    component_name=db_context["component"],
                    device_name=db_context["device"],
                )
            )

        # 5. Build the OpenAI/Groq message list.
        messages: list[dict] = []

        # System prompt — sets persona and behaviour for both first turn and follow-ups.
        system_lines = [
            "You are SysOps AI, a senior IT infrastructure engineer acting as a 'Senior Engineer in a Box' "
            "for system administrators, network engineers, and on-call SREs.",
            "When a retrieved documentation context is provided, ground your answer ONLY in that context.",
            "Lead with a one-line root-cause hypothesis, then give numbered remediation steps with the exact "
            "CLI commands, GUI paths, IPMI/BMC actions, hex codes, or LED meanings the engineer needs.",
            "Where applicable, include the safe order of operations (e.g., drain first, then reboot), any "
            "required maintenance window or downtime risk, and a verification step at the end.",
            "Use Markdown formatting (headings, ordered lists, fenced code blocks for commands).",
        ]
        if db_context:
            system_lines.append(
                f"\nCRITICAL: The retrieved documentation is for a **{db_context['device']}**. Every CLI "
                f"command, model number, error code, LED meaning, firmware path, and recommendation in your "
                f"response must be accurate for this exact device. Do not reference commands or procedures "
                f"from any other vendor or model."
            )
        messages.append({"role": "system", "content": "\n".join(system_lines)})

        # Prior conversation turns (translated from Gemini format).
        messages.extend(_convert_history_to_openai(history))

        # Current user turn — this varies based on whether an image is attached.
        user_content_parts = []

        if db_context:
            user_content_parts.append(
                "Retrieved documentation from the SysOps knowledge base:\n\n"
                f"Device: {db_context['device']}\n"
                f"Component: {db_context['component']}\n"
                f"Documentation / Resolution Steps: {db_context['resolution']}\n"
            )

        if text_issue:
            user_content_parts.append(f"Engineer's description: {text_issue}")

        if audio_transcript:
            user_content_parts.append(
                f"[Audio transcript (Whisper) — what the engineer said in the recording: {audio_transcript}]"
            )
        elif audio_bytes:
            user_content_parts.append(
                "[Audio file was attached but Whisper produced no transcript — likely a non-speech "
                "recording such as raw beep codes. Ask the engineer to describe the sound in text.]"
            )

        # If an image is present, send the multimodal message form. Otherwise plain text.
        if image_data_url:
            user_message = {
                "role": "user",
                "content": [
                    {"type": "text", "text": "\n\n".join(user_content_parts) or "Please diagnose what is shown in the image."},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }
            target_model = GROQ_VISION_MODEL
        else:
            user_message = {
                "role": "user",
                "content": "\n\n".join(user_content_parts) or "Please continue the diagnostic.",
            }
            target_model = GROQ_TEXT_MODEL

        messages.append(user_message)

        # 6. Call Groq.
        def _chat():
            return groq_client.chat.completions.create(
                model=target_model,
                messages=messages,
                temperature=0.3,
                max_tokens=1500,
            )

        response = await groq_call_with_retry(_chat)
        ai_text = response.choices[0].message.content or ""

        return {
            "identified_part": db_context["component"] if db_context else "Continuing Conversation",
            "confidence": round(db_context["score"], 3) if db_context else None,
            "image_url": db_context.get("image_url") if db_context else None,
            "ai_response": ai_text,
            "graph_data": subgraph_data,
        }

    except HTTPException:
        raise
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail="Groq API request timed out. Please try again.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
