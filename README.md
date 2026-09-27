# HTU demo Moodle with Rennix LTI

A local, end-to-end demo of Rennix running inside an HTU-style Moodle over **LTI 1.3**:
a real Moodle 5.2 (Docker) styled after HTU eLearning, with **Rennix Tutor Bot** and
**Rennix Analytics** installed as External Tools, launching into `rennix-lti` and `tutor-service`.

What you can try:

- **LTI launches** from Moodle as a teacher or student (Analytics blocks students by design)
- **Rennix dashboard** at the top of the course page, with a *Go to course content* button to the tiles
- **Video + Tutor Bot side by side**: every Vimeo lecture video gets the Tutor Bot chat framed to its right
- **"Paused at 2:45" questions**: the Moodle plugin reports the Vimeo position, so the Tutor Bot answers
  from that moment of that lecture
- **Knowledge check** under each video, graded, with explanations
- **Grades back to Moodle** (LTI Assignment and Grade Services) and **roster sync** (NRPS)
- A lightweight **fake LMS** (`localhost:3003`) for quick launches without Moodle

## How it fits together

```
 Moodle (Docker, :8085) ──LTI 1.3 launch──▶ rennix-lti (:3002) ──signed bridge token──▶ tutor-service (:3001)
   │  local_rennixtutorbot plugin                 ▲   │                                    │
   │  (Vimeo position, side panel,                │   └── /ags/score, NRPS ─────────▶ Moodle gradebook/roster
   │   knowledge check, dashboard) ── positions ──┘                                        │
   └──────────────────────── framed chat panel / knowledge check / dashboard ◀────────────┘
 fake LMS (:3003) ──LTI 1.3 launch──▶ rennix-lti  (tenant "demo")
```

## Setup (once)

You need Docker Desktop, Node.js 20+ and git. Everything is in this one repository:

```
htu-demo-moodle-lti/
  demo/                  <- this demo: Moodle setup, launcher, fake LMS, checks
  rennix-lti/            <- LTI 1.3 tool service
  tutor-service/         <- the Rennix app (Tutor Bot, dashboards, analytics)
  local_rennixtutorbot/  <- Moodle plugin (Vimeo position, side panel, knowledge check, dashboard)
```

```bash
git clone <this repo> && cd htu-demo-moodle-lti
cd rennix-lti && npm install && cd ..
cd tutor-service && npm install && cd ..
cd demo/moodle && node install.js    # Moodle, plugins, HTU look, courses, LTI tools
cd .. && node start-all.js           # tutor-service + rennix-lti + fake LMS (keep running)
node seed-demo.js                    # in a second terminal, from demo/: link the demo video + questions
```

`install.js` is safe to re-run. Set `OPENAI_API_KEY` in your environment before `start-all.js` to enable the
AI answers; without it everything else works and the chat replies with an error.

**HTU branding:** HTU's logo and campus photo are not included (they're HTU's). To get the full look, save them as
`demo/moodle/assets/htu-logo.png`, `htu-favicon.png` and `htu-background.png` and re-run `node install.js`.

## Logging in

| Where | Username | Password |
|---|---|---|
| Moodle `http://localhost:8085` | `admin`, `teacher1`, `student1` | generated into `demo/moodle/.env` |
| rennix-lti admin `http://localhost:3002/admin` | - | `ADMIN_SECRET` in `demo/data/dev-secrets.json` |

All generated locally on first run; nothing here is a real account.

## LTI configuration

`start-all.js` registers the Moodle automatically (from `demo/moodle/setup-result.txt`). To enter it by hand in
rennix-lti's **Onboard a school** form, use tenant key `htu` and these values; the client IDs are generated
by your Moodle, so read them from `demo/moodle/setup-result.txt` or Moodle's *Manage tools* page.

| rennix-lti field | Moodle's name for it | Value |
|---|---|---|
| Issuer | Platform ID | `http://localhost:8085` |
| Client ID | Client ID | from `setup-result.txt` (one per tool) |
| Deployment ID | Deployment ID | `1` (Tutor Bot), `2` (Analytics) |
| Auth login URL | Authentication request URL | `http://localhost:8085/mod/lti/auth.php` |
| Access token URL | Access token URL | `http://localhost:8085/mod/lti/token.php` |
| JWKS URL | Public keyset URL | `http://localhost:8085/mod/lti/certs.php` |

Moodle side (Site administration → Plugins → Activity modules → External tool → Manage tools):

| Moodle field | Value |
|---|---|
| Tool URL, Redirection URI | `http://localhost:3002/lti/launch` |
| Initiate login URL | `http://localhost:3002/lti/login` |
| Public keyset | `http://host.docker.internal:3002/lti/jwks` (Moodle runs in Docker) |

## Checks

With everything running, from `demo/moodle/`:

```bash
node smoke-launch.js teacher1       # every tool launches for a teacher
node smoke-launch.js student1       # ...and for a student (Analytics correctly refused)
node smoke-playback.js              # Vimeo position reaches the Tutor Bot, tampered tokens rejected
node smoke-knowledge-check.js       # dashboard + knowledge check load and grade
node smoke-grades.js                # a quiz answer lands in Moodle's gradebook
```

## Known limits

- The demo video is Blender's CC-licensed *Big Buck Bunny*; the knowledge-check questions are seeded
  (`seed-demo.js`). For real lectures, ingest the transcript and generate questions with `/quiz/generate`.
- Course titles mirror an HTU course outline; course text is placeholder.
- Local only: everything is `http://localhost`. In production the Tutor Bot panel runs as a cross-site
  iframe and relies on a `SameSite=None; Partitioned` cookie, which can't be exercised on localhost.
