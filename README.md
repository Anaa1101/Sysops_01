# SysOps AI

> **A "Senior Engineer in a Box"** — a multimodal RAG-powered diagnostic assistant for IT infrastructure. Describe a symptom in text, drop a photo of a blinking LED, or upload a recording of beep codes — and get back vendor-accurate, step-by-step fixes drawn from real manufacturer manuals.

![Stack](https://img.shields.io/badge/stack-FastAPI%20%2B%20React%20%2B%20Neo4j-orange)
![LLM](https://img.shields.io/badge/LLM-Groq%20Llama%203.3-purple)
![Embeddings](https://img.shields.io/badge/embeddings-MiniLM--L6--v2-green)
![Deploy](https://img.shields.io/badge/deploy-Docker%20Compose-blue)

---

## Table of Contents

- [What It Does](#what-it-does)
- [Why It Exists](#why-it-exists)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Local Development (without Docker)](#local-development-without-docker)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Adding New Manuals](#adding-new-manuals)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

---

## What It Does

It's 3:00 AM. A core network switch in your data center is throwing an amber blinking light. You don't know what it means. Your options today:

1. Google "amber blinking LED Cisco" → wade through 12 forum posts of varying quality.
2. Open the Cisco Catalyst 9300 PDF (500 pages) → hunt for the right section.
3. Wake your senior engineer at 3 AM (the most expensive option).

**SysOps AI is option 4:** show the symptom, get the fix.

You can:
- **Type** a symptom: *"Cat 9300 port amber LED, link is down"* → get the err-disabled recovery steps.
- **Drop a photo** of the failing hardware → vision LLM describes what it sees, then looks up the fix.
- **Upload an audio recording** of beep codes → Whisper transcribes, the system matches the pattern, returns the resolution.

The reply contains real CLI commands, real config snippets, real button-paths in real GUIs — drawn from the documentation database, not invented by the model.

---

## Why It Exists

Three real problems in IT operations:

1. **Documentation is scattered.** Every vendor has its own PDF, portal, version-specific quirks. Nobody has all of it loaded in their head.
2. **Symptoms aren't always describable in words.** Sometimes it's a blinking pattern, a beep rhythm, a warning sound — easier to *show* than to type.
3. **LLMs hallucinate fake CLI commands.** Ask ChatGPT to fix your Cisco switch and it might invent `show error-fix-now` (not a real command). RAG fixes this — the LLM is forced to ground its answer in retrieved manual text.

This project shows how to combine **vector search + graph traversal + multimodal input + grounded generation** in a single, runnable system.

---

## How It Works

### The RAG flow

```
[ User input — text + optional image + optional audio ]
                            │
                            ▼
        ┌───────────────────────────────────────┐
        │ Step 1.  Translate non-text inputs    │
        │   image  → Groq Vision  (Llama-4)     │
        │   audio  → Whisper-v3                 │
        └───────────────┬───────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────┐
        │ Step 2.  Combine all inputs           │
        │ Step 3.  Embed → 384-d vector         │
        │          (sentence-transformers)      │
        └───────────────┬───────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────┐
        │ Step 4.  RETRIEVE                     │
        │   Neo4j vector search over Components │
        │   Graph walk → parent Device          │
        │              → child Resolution       │
        └───────────────┬───────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────┐
        │ Step 5.  AUGMENT                      │
        │   Pack: symptom + retrieved manual    │
        │         + image (base64) + transcript │
        └───────────────┬───────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────┐
        │ Step 6.  GENERATE                     │
        │   Groq Llama 3.3 with strict prompt   │
        │   "Answer ONLY using this manual"     │
        └───────────────┬───────────────────────┘
                        │
                        ▼
        [ Vendor-accurate fix + interactive graph view ]
```

### The knowledge graph

Each entry from `backend/data/manuals.json` becomes three connected nodes in Neo4j:

```
(Device {name})  ─[:HAS_COMPONENT]─►  (Component {name, embedding[384], image_url})
                                                   │
                                                   ▼
                                       [:HAS_RESOLUTION]
                                                   │
                                                   ▼
                                      (Resolution {issue, text})
```

The Component node carries the **384-dimensional embedding**. Neo4j 5's native `VECTOR INDEX` runs cosine-similarity search directly on these vectors — same database, no separate vector store. The graph relationships let us:

- **Filter** vector search by device (e.g. only Catalyst 9300 components).
- **Walk** in one Cypher query: matched Component → its Device → its Resolution.
- **Visualise** the same data as an interactive force-graph in the UI.

---

## Tech Stack

| Layer | Tool | Why |
|---|---|---|
| **Frontend** | React 18 + Vite + Tailwind CSS | Fast HMR, utility-first styling, port `:3000` |
| **Graph viz** | `react-force-graph-2d` | Renders the live Neo4j graph as an interactive 2-D map |
| **Backend** | FastAPI + Uvicorn + Python 3.11 | Async I/O, multipart uploads, auto OpenAPI docs at `/docs` |
| **Text LLM** | Groq · `llama-3.3-70b-versatile` | Hosted, fast inference, generous free tier |
| **Vision LLM** | Groq · `meta-llama/llama-4-scout-17b-16e-instruct` | Inline base64 image understanding (no Files API needed) |
| **Audio** | Groq · `whisper-large-v3-turbo` | Speech-to-text for beep / alarm transcripts |
| **Embeddings** | `sentence-transformers/all-MiniLM-L6-v2` | 384-d, CPU-friendly, semantic short-text matching |
| **Database** | Neo4j 5 Community | Graph + native vector index in one DB |
| **Deploy** | Docker Compose | One command boots all three services |

---

## Quick Start

### Prerequisites

- **Docker Desktop** — engine running, at least 4 GB RAM allocated.
- **A Groq API key** — get a free one at <https://console.groq.com/keys>.
- **About 30 GB of free disk space** — Neo4j + backend + frontend images.

### 1. Clone & configure

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>

# Create the backend env file
cat > backend/.env <<EOF
GROQ_API_KEY=gsk_your_key_here
NEO4J_URI=bolt://neo4j:7687
NEO4J_AUTH_USER=neo4j
NEO4J_AUTH_PASS=sysopsdevpass
EOF
```

> ⚠️ The Neo4j password (`sysopsdevpass`) must match the one in `docker-compose.yml`. If you change one, change both.

### 2. Boot all services

```bash
docker compose up --build
```

The first build can take **10–15 minutes** because PyTorch (a sentence-transformers dependency) bundles ~2 GB of CUDA wheels even on macOS. Subsequent runs start in seconds.

You'll know it's ready when you see:

```
neo4j-1     | Started.
backend-1   | INFO:  Uvicorn running on http://0.0.0.0:8000
frontend-1  | VITE  Local: http://localhost:3000
```

### 3. Load the knowledge base

In a **second terminal**:

```bash
docker compose exec backend python ingest.py
```

You should see `Ingest complete. 31 entries ingested.` after ~30 seconds.

### 4. Open the app

| URL | What it is |
|---|---|
| <http://localhost:3000> | Frontend chat UI |
| <http://localhost:8000/docs> | FastAPI auto-generated API docs |
| <http://localhost:7474> | Neo4j browser (login `neo4j` / `sysopsdevpass`) |

Try a query like:

> *"Cisco Catalyst 9300 amber LED on port, link is down"*

You should get an err-disabled recovery procedure with `show interfaces`, `shutdown / no shutdown`, and fiber-cleaning steps.

---

## Local Development (without Docker)

You'll need Python 3.11+, Node 18+, and a running Neo4j instance.

```bash
# 1. Start Neo4j (one-liner via Docker just for the DB)
docker run --name neo4j-dev -p7474:7474 -p7687:7687 \
  -e NEO4J_AUTH=neo4j/sysopsdevpass neo4j:5-community

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Make sure backend/.env has NEO4J_URI=bolt://localhost:7687 (not "neo4j")
uvicorn main:app --reload   # serves on :8000

# 3. Ingest
python ingest.py

# 4. Frontend (new terminal)
cd frontend
npm install
npm run dev   # serves on :3000 (or whatever vite.config.js says)
```

---

## Project Structure

```
project_rag_rit/
├── docker-compose.yml          # Orchestrates neo4j + backend + frontend
├── README.md                   # You are here
├── architecture_explanation.txt
├── SysOpsAI_Presentation.pptx  # 17-slide overview deck
│
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── main.py                 # FastAPI app — /diagnose, /graph-data, /health
│   ├── ingest.py               # Loads manuals.json into Neo4j (with vector index)
│   └── data/
│       └── manuals.json        # 31 device-symptom-fix entries (knowledge base)
│
└── frontend/
    ├── Dockerfile
    ├── package.json
    ├── vite.config.js          # Dev server on :3000
    ├── tailwind.config.js
    ├── index.html
    └── src/
        ├── main.jsx            # React entry point
        ├── index.css           # Global styles + font imports
        ├── App.jsx             # Chat + tab toggle + input footer
        └── components/
            └── GraphView.jsx   # Interactive force-graph (devices ↔ components ↔ fixes)
```

---

## API Reference

The backend exposes three endpoints. Auto-generated Swagger docs are at <http://localhost:8000/docs>.

### `GET /health`

Liveness check. Confirms the service is up and Neo4j is reachable.

```json
{ "status": "ok", "database": "connected" }
```

### `GET /graph-data`

Returns the full graph data for the visualization (all devices, components, resolutions, and their edges).

Optional query parameter `component=<name>` returns only the subgraph around that component.

```json
{
  "nodes": [
    { "id": "Cisco Catalyst 9300 Switch", "label": "Cisco Catalyst 9300 Switch", "type": "Device" },
    { "id": "SFP+ Transceiver", "label": "SFP+ Transceiver", "type": "Component" }
  ],
  "links": [
    { "source": "Cisco Catalyst 9300 Switch", "target": "SFP+ Transceiver", "type": "HAS_COMPONENT" }
  ]
}
```

### `POST /diagnose`

The main RAG endpoint. Accepts `multipart/form-data` with any combination of:

| Field | Type | Description |
|---|---|---|
| `text_issue` | string | Plain-text symptom description |
| `image` | file | Photo of LED panel / hardware (max 10 MB) |
| `audio` | file | Recording of beep code / alarm (max 25 MB) |
| `chat_history` | string (JSON) | Prior messages in Gemini format `[{role, parts:[{text}]}]` |

Returns:

```json
{
  "ai_response":      "DIAGNOSTIC: ...\nRESOLUTION: Step 1 ...",
  "identified_part":  "SFP+ Transceiver",
  "confidence":       0.87,
  "image_url":        "https://placehold.co/600x400/1ba0d7/ffffff?text=...",
  "graph_data":       { "nodes": [...], "links": [...] }
}
```

`identified_part` and `image_url` are returned only on the first turn of a conversation. Follow-up turns reuse the existing context.

---

## Environment Variables

All loaded by `python-dotenv` from `backend/.env`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ | — | Your Groq API key |
| `NEO4J_URI` | ✅ | `bolt://neo4j:7687` | Bolt URL of Neo4j |
| `NEO4J_AUTH_USER` | ✅ | — | Neo4j username (default `neo4j`) |
| `NEO4J_AUTH_PASS` | ✅ | — | Neo4j password (matches `docker-compose.yml`) |
| `GROQ_TEXT_MODEL` | ❌ | `llama-3.3-70b-versatile` | Override the text model |
| `GROQ_VISION_MODEL` | ❌ | `meta-llama/llama-4-scout-17b-16e-instruct` | Override the vision model |
| `GROQ_AUDIO_MODEL` | ❌ | `whisper-large-v3-turbo` | Override the audio model |

The frontend reads `VITE_API_URL` (set in `docker-compose.yml`) — defaults to `http://localhost:8000`.

---

## Adding New Manuals

The knowledge base is a single JSON file: `backend/data/manuals.json`. Each entry follows this schema:

```json
{
  "device":          "Cisco Catalyst 9300 Switch",
  "component":       "SFP+ Transceiver",
  "issue":           "Amber Blinking Port LED and Link Down",
  "search_summary":  "SFP+ transceiver fiber optic module port amber blinking LED link down err-disabled GBIC mismatch unsupported.",
  "resolution":      "DIAGNOSTIC: An amber blinking port LED on a Cat 9300 typically indicates an err-disabled state ... Step 1: Run `show interfaces status err-disabled` ...",
  "image_url":       "https://placehold.co/600x400/1ba0d7/ffffff?text=Cisco%5CnSFP%2B+Transceiver"
}
```

Field roles:

- **`device`** — the parent vendor product. Used for graph grouping and filtered search.
- **`component`** — what specifically is failing. Used as the embedding "anchor".
- **`issue`** — short title of the problem. Used as the Resolution node identifier.
- **`search_summary`** — keyword-rich one-liner. Combined with `component` to form the embedded text — *this is what enables symptom matching*.
- **`resolution`** — the full step-by-step fix. Returned to the user.
- **`image_url`** — displayed alongside the answer.

To add new entries:

1. Append to `manuals.json` in the schema above.
2. Re-ingest:
   ```bash
   docker compose exec backend python ingest.py
   ```
3. The script wipes and re-creates everything via `MERGE` (idempotent — safe to re-run).

---

## Configuration

### File-size limits

In `backend/main.py`:

```python
MAX_IMAGE_BYTES = 10 * 1024 * 1024   # 10 MB
MAX_AUDIO_BYTES = 25 * 1024 * 1024   # 25 MB
GROQ_TIMEOUT    = 90.0               # seconds per Groq call
```

### Switching models

You can swap any Groq model by setting the env var without changing code. For example, to try a smaller / faster text model:

```env
GROQ_TEXT_MODEL=llama-3.1-8b-instant
```

### Vector index parameters

In `backend/ingest.py`, the index is created with:

```cypher
CREATE VECTOR INDEX component_embeddings
FOR (c:Component) ON (c.embedding)
OPTIONS {indexConfig: {
    `vector.dimensions`: 384,
    `vector.similarity_function`: 'cosine'
}}
```

If you swap the embedding model to one with a different output dimension, update `vector.dimensions` accordingly.

---

## Limitations

| Area | Trade-off | Future fix |
|---|---|---|
| **Data coverage** | 31 vendor-symptom pairs is small for production | Expand corpus or scrape vendor PDFs into the same schema |
| **Vision quality** | Llama-4 Scout misses fine LED-pattern nuance under bad lighting | Switch to GPT-4V or Gemini 2.5 Flash for higher-fidelity reasoning |
| **Audio matching** | Whisper transcribes speech, not raw beep patterns — pure beep audio yields garbage | Train a small CNN classifier for vendor-specific beep sequences |
| **Single-tenant DB** | Neo4j has no namespace isolation here — all users share one graph | Per-org Neo4j databases or label-based multi-tenancy |
| **No streaming** | Full response is returned only after Groq completes | Switch to `chat.completions.create(stream=True)` and SSE |
| **First-build slowness** | PyTorch bundles 2 GB of CUDA wheels even on macOS | Use `torch+cpu` index in `requirements.txt` to skip CUDA |

---

## Roadmap

- [ ] **Streaming responses** — SSE from Groq for real-time text
- [ ] **Vendor filter UI** — dropdown to scope search to one vendor
- [ ] **Top-K slider** — let users see why a result matched
- [ ] **Inline manual cards** — show retrieved Resolution snippets alongside the answer
- [ ] **CPU-only torch** — drop ~2 GB from the backend image
- [ ] **Eval harness** — automated tests over a held-out symptom set
- [ ] **Larger corpus** — ingest 500+ entries from public vendor PDFs

---

## Credits

- **Groq** for hosted Llama 3.3 / Llama-4 Scout / Whisper inference.
- **Neo4j** for native graph + vector storage.
- **sentence-transformers** for the MiniLM embedding model.
- **react-force-graph-2d** for the interactive graph rendering.
- Project deck (`SysOpsAI_Presentation.pptx`) inspired by the layout patterns in *Multimodal RAG Knowledge Graph System* by the Neural Alchemists team.
