# tutor-service

Standalone RAG tutor bot + analytics companion for a Moodle course (CS101 demo). Runs as its
own Docker service, decoupled from the Moodle stack — it only needs a published port the
browser can reach.

## Features

- Per-lecture "Ask AI" chat, grounded in that video's transcript (OpenAI embeddings +
  chat completions), with timestamp-aware retrieval ("what happened at minute X").
- Video engagement tracking (play/pause/seek/heartbeat/ended) fed by a small script embedded
  in each Moodle lecture page.
- In-video pop-up questions that pause playback and record answered/dropped.
- Per-student notes tab, tied to lecture + video timestamp.
- Bookable formative sessions (`/sessions`).
- Leaderboard (`/leaderboard`) combining video completion, quiz score, and chat engagement.
- Instructor dashboard (`/instructor`) with section ranking, per-student drill-down (exact
  stop-points, who hasn't watched), quiz completion, at-risk flagging, and a chatbot
  content-gap report.

## Setup

```bash
cp .env.example .env   # fill in OPENAI_API_KEY
docker compose up -d --build
```

Then embed `/widget/:lectureId` as an iframe next to each lecture video, and point the video's
tracking script (see the Moodle build scripts) at this service's published port.

## Data

SQLite (`better-sqlite3`), persisted via the `tutor_data` Docker volume. No external DB
required.
