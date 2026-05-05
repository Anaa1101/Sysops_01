import os
import json
from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv

load_dotenv()

print("Loading semantic embedding model... (This may take a minute on the first run)")
# all-MiniLM-L6-v2 is a dedicated semantic similarity model (384 dims).
# It handles text-to-text matching far better than CLIP, which is a vision-
# language model with a 77-token limit — not designed for technical IT text search.
model = SentenceTransformer('all-MiniLM-L6-v2')

URI = os.getenv("NEO4J_URI", "bolt://neo4j:7687")
AUTH = (os.getenv("NEO4J_AUTH_USER", ""), os.getenv("NEO4J_AUTH_PASS", ""))
DATA_FILE = "data/manuals.json"


def get_text_embedding(text: str):
    return model.encode(text).tolist()


def delete_all_nodes(tx):
    tx.run("MATCH (n) DETACH DELETE n")


def insert_item(tx, item, vector):
    query = """
        MERGE (dev:Device {name: $device_name})
        MERGE (comp:Component {name: $comp_name})
        SET comp.embedding = $vector,
            comp.image_url = $image_url
        MERGE (res:Resolution {issue: $issue})
        SET res.text = $resolution_text
        MERGE (dev)-[:HAS_COMPONENT]->(comp)
        MERGE (comp)-[:HAS_RESOLUTION]->(res)
    """
    tx.run(
        query,
        device_name=item.get("device", "Unknown Device"),
        comp_name=item.get("component", "Unknown Component"),
        vector=vector,
        image_url=item.get("image_url", ""),
        issue=item.get("issue", "General Diagnostic"),
        resolution_text=item.get("resolution", "")
    )


def main():
    print(f"Reading data from {DATA_FILE}...")
    try:
        with open(DATA_FILE, "r") as f:
            manuals = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: {DATA_FILE} not found.")
        return

    print(f"Found {len(manuals)} entries to ingest.\n")

    print("Connecting to Neo4j...")
    with GraphDatabase.driver(URI, auth=AUTH) as driver:
        with driver.session() as session:

            print("Clearing old database entries...")
            session.execute_write(delete_all_nodes)

            print("Dropping and recreating vector index...")
            session.run("DROP INDEX component_embeddings IF EXISTS")
            session.run("""
                CREATE VECTOR INDEX component_embeddings IF NOT EXISTS
                FOR (c:Component) ON (c.embedding)
                OPTIONS {indexConfig: {
                    `vector.dimensions`: 384,
                    `vector.similarity_function`: 'cosine'
                }}
            """)

            print("Processing and embedding data...\n")
            for item in manuals:
                component = item.get("component", "Unknown")
                device = item.get("device", "Unknown")
                print(f"  Ingesting: {device} / {component}")
                # Embed component name + search_summary so that direct part-name
                # queries ("SFP+ transceiver", "PERC RAID controller") align strongly
                # with the stored vector while symptom-only queries ("amber blinking
                # LED") still match via the summary. Device-name disambiguation remains
                # in Cypher (WHERE clause) so no device name is added here — that would
                # hurt generic queries.
                embed_text = f"{component}: {item.get('search_summary', component)}"
                vector = get_text_embedding(embed_text)
                session.execute_write(insert_item, item, vector)

    print(f"\nIngest complete. {len(manuals)} entries ingested.")
    print("Database is ready for RAG.")


if __name__ == "__main__":
    main()
