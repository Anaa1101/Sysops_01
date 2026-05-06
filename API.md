# SysOps AI Core - API Documentation

This document outlines the REST API endpoints provided by the SysOps AI Core backend, which is built with FastAPI.

## Base URL

By default, the backend runs locally. The base URL depends on your configuration (e.g., `http://localhost:8000`).

---

## Endpoints

### 1. Health Check

Checks the status of the API and the connection to the Neo4j database.

*   **URL**: `/health`
*   **Method**: `GET`
*   **Query Parameters**: None
*   **Body**: None

**Success Response (200 OK):**
```json
{
  "status": "ok",
  "database": "connected"
}
```

**Error Response (503 Service Unavailable):**
```json
{
  "detail": "Database unavailable: <error message>"
}
```

---

### 2. Graph Data

Retrieves the knowledge graph data structure (nodes and links) for a given component or the entire graph if no component is specified.

*   **URL**: `/graph-data`
*   **Method**: `GET`
*   **Query Parameters**:
    *   `component` (Optional, string): The name of the specific component or issue to filter the graph by.

**Success Response (200 OK):**
```json
{
  "nodes": [
    { "id": "element_id_1", "label": "Device", "name": "Server Model X" },
    { "id": "element_id_2", "label": "Component", "name": "Power Supply" }
  ],
  "links": [
    { "source": "element_id_1", "target": "element_id_2", "label": "HAS_COMPONENT" }
  ]
}
```

**Error Response (200 OK with internal error message):**
```json
{
  "error": "<error message>"
}
```

---

### 3. Diagnose Issue

The core endpoint for diagnosing a hardware issue using text, audio, and/or image inputs. It utilizes RAG against the Neo4j database and Groq AI models.

*   **URL**: `/diagnose`
*   **Method**: `POST`
*   **Content-Type**: `multipart/form-data`

**Form Data Parameters:**
*   `image` (Optional, File): An image of the hardware or error screen (Max: 10MB).
*   `audio` (Optional, File): An audio recording of the engineer or beep codes (Max: 25MB).
*   `text_issue` (Optional, String): A text description of the problem.
*   `chat_history` (Optional, String, default: `"[]"`): A JSON array string representing the previous conversation history in Gemini format `[{"role": "user", "parts": [{"text": "..."}]}]`.

*Note: For the initial query, at least one of `image`, `audio`, or `text_issue` must be provided.*

**Success Response (200 OK):**
```json
{
  "identified_part": "Power Supply Unit",
  "confidence": 0.895,
  "image_url": "http://example.com/psu.jpg",
  "ai_response": "## Root Cause Hypothesis...\n\n1. Step 1...\n2. Step 2...",
  "graph_data": {
    "nodes": [...],
    "links": [...]
  }
}
```

**Error Responses:**
*   **400 Bad Request:** E.g., File too large, invalid `chat_history` JSON, or missing initial input.
*   **404 Not Found:** No matching component found in the database.
*   **429 Too Many Requests:** Groq API rate limit reached.
*   **502 Bad Gateway:** Transient Groq API error.
*   **504 Gateway Timeout:** Groq API request timed out.
*   **500 Internal Server Error:** Other unexpected errors.
