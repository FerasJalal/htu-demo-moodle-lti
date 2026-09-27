# rennix-lti

LTI 1.3 Tool (the "Tool" side of the spec) that any institution's LMS launches into as a standard
**External Tool** — no custom plugin install, no backend access on their side. Separate from
`tutor-service` (the single-tenant HTU pilot); this is the multi-tenant connector.

Two independently purchasable products, registered as two separate External Tools per
institution (each gets its own `client_id` from their LMS admin):

- **Rennix Analytics**
- **Rennix Tutor Bot**

**Status: live-tested against HTU's real Moodle.** Both tools are registered there (via
`mod_lti`'s own `lti_add_type()`, not hand-rolled DB rows) and a real signed launch was verified
end-to-end as `teacher1` for both. Two real bugs were caught by that test and are fixed on `main`:
Moodle sends the OIDC login-initiation request via POST (the spec allows either GET or POST;
only GET was implemented at first), and `req.protocol` needs `app.set('trust proxy', true')` or
it reports `http` behind Caddy, breaking `redirect_uri` matching.

## How a launch works

1. Institution's admin adds an External Tool in their LMS pointing at
   `https://<this-service>/lti/login`, using a `client_id`/`deployment_id` we issue them (manual
   registration), or via `https://<this-service>/lti/register` if their LMS supports Dynamic
   Registration -- see "Registering a platform" below either way.
2. We record that registration in our own database.
3. A user launches the tool from their course. Their LMS redirects the browser to `/lti/login`,
   we redirect to the LMS's own auth endpoint, the LMS POSTs back a signed `id_token` to
   `/lti/launch`, we verify it against the LMS's published JWKS, and only then trust the
   identity/role/course claims inside it.

## Setup

```bash
cp .env.example .env   # set ADMIN_SECRET, SESSION_SECRET, and KEY_ENCRYPTION_SECRET to real random values
docker compose up -d --build
```

Admin pages: `/admin` (onboard/manage platforms) and `/admin/audit` (audit log), both behind
`/admin/login`.

## Registering a platform

### Dynamic Registration (preferred, where the LMS supports it)

For Canvas, newer Moodle, and any other LTI 1.3 Dynamic-Registration-capable LMS: point the
institution's admin at `https://<this-service>/lti/register` as the tool's registration URL in
their LMS's own "add a Dynamic Registration tool" flow. The LMS opens that URL (usually in a
popup) with `openid_configuration` and (if the platform issues one) `registration_token` query
params; a short picker page asks which Rennix product and tenant this is for, then the tool
completes the registration itself -- no manual `/admin/platforms` call needed. The resulting
platform is active immediately (the `registration_token` is itself the admin's proof of
authorization). Not every platform hands over a `deployment_id` at registration time (Canvas
typically doesn't; Moodle typically does) -- when it doesn't, the first one seen inside a real,
signature-verified launch is auto-registered rather than rejected, scoped to
Dynamic-Registration-created platforms only (see `src/lti/launch.js`).

### Manual (Moodle's `mod_lti`, or any platform without Dynamic Registration)

```bash
curl -X POST https://<this-service>/admin/platforms \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "product": "tutor_bot",
    "tenantKey": "htu",
    "tenantName": "Al-Hussein Technical University",
    "issuer": "https://edu.rennix.ai",
    "clientId": "<from their LMS admin External Tool config>",
    "deploymentId": "<from their LMS admin External Tool config>",
    "authLoginUrl": "https://edu.rennix.ai/mod/lti/auth.php",
    "authTokenUrl": "https://edu.rennix.ai/mod/lti/token.php",
    "jwksUrl": "https://edu.rennix.ai/mod/lti/certs.php"
  }'
```

`authTokenUrl` (Moodle's "Access token URL") is optional for launches but required for NRPS roster
sync and AGS grade push -- without it both fail with "no auth_token_url registered". Platforms
registered before this field existed can be fixed from the **Edit** link on `/admin`.

## Data

SQLite (`better-sqlite3`), persisted via the `lti_data` Docker volume — just platform
registrations and short-lived login state/nonces, nothing else.

## How a verified launch reaches the real app

A verified launch mints a signed bridge token (`LTI_BRIDGE_SECRET`, shared with tutor-service —
separate from block_criterio's `IDENTITY_SECRET`) and redirects straight to tutor-service's real
`/app/instructor` or `/app/home`. tutor-service is multi-tenant as of the corresponding change
there: each institution gets its own fully isolated database, resolved only from this signed
token, never a client-suppliable parameter. LTI's own user identifier (`sub`, an opaque
platform-chosen string) is mapped to a stable per-tenant integer id on first launch and reused on
every later one; first-time users are auto-provisioned from the platform's own verified
name/email/role claims, since there's no Moodle-style manual roster sync for institutions that
connect this way.

`/lti/launched` (the old proof-of-concept identity page) is still there but no longer used by the
real flow — harmless to keep as a debug page.

## Grades (Assignment and Grade Services)

Scores are pushed into the institution's own LMS gradebook via LTI's Assignment and Grade
Services. This service only implements its half — the LMS-facing plumbing (capturing each
activity's gradebook endpoint, creating a line item if one doesn't exist yet, submitting scores).
**Nothing in this repo decides when a score is ready or calls this on its own** — `tutor-service`
is expected to call it once it has a graded event to report. That's the contract:

### `POST /ags/score`

Header: `x-tenant-admin-secret: <TENANT_ADMIN_SECRET>` (same shared secret already used for the
`/students/sync`-style calls in the other direction).

Body (JSON):

```json
{
  "tenant": "htu",
  "userid": 100042,
  "resourceLinkId": "the resource_link_id from that activity's original LTI launch",
  "score": 8,
  "scoreMaximum": 10,
  "label": "optional -- gradebook column name, only used if a line item has to be created",
  "activityProgress": "optional, defaults to \"Completed\"",
  "gradingProgress": "optional, defaults to \"FullyGraded\""
}
```

- `userid` is tutor-service's own internal id for the student (the same one everywhere else in
  this integration), not the platform's own opaque `sub`.
- `resourceLinkId` has to be the exact `resource_link_id` captured from that specific activity's
  launch -- this is how the call gets resolved back to a platform + gradebook endpoint. There's no
  way to push a score for an activity nobody has ever launched.

Responses:
- `200 {"ok": true}` — pushed successfully (a line item was auto-created first if this was the
  first score ever pushed for that `resourceLinkId`).
- `400` — missing required fields, or the named student has no recorded LTI launch on the relevant
  platform (no `sub` to attribute the score to).
- `401` — missing/wrong `x-tenant-admin-secret`.
- `403` — `tenant` doesn't match the tenant that `resourceLinkId` actually belongs to.
- `404` — unknown `resourceLinkId` (either that platform never granted AGS access for it, or it
  was never launched at all).
- `502` — reached this service fine, but the platform itself rejected the line-item-creation or
  score-submission call.

Manually-registered platforms need the AGS **Line Item** and **Score** service scopes enabled on
the External Tool config by the institution's admin (Dynamic Registration requests them
automatically).

## Architecture

`server.js` is only the composition root (middleware + router mounting + listen). The actual
routes and business logic live in `src/`:

- `src/config.js`, `src/db.js`, `src/audit.js` -- shared config, SQLite schema/access, admin audit
  logging.
- `src/security/` -- token signing/verification (bridge token, admin session, this tool's own
  RS256 key pair for signing outbound JWTs).
- `src/rateLimit.js` -- in-memory per-process rate limiting (single-instance only, see below).
- `src/lti/` -- the LTI protocol itself: login, launch/verification, Deep Linking, Dynamic
  Registration, NRPS roster sync, AGS score push, role mapping, and the cached-per-platform JWKS
  lookup.
- `src/admin/` -- the admin auth/session, platform registration API, and onboarding UI.

Run `npm test` (Node's built-in test runner, `test/`) to exercise the JWT verification, nonce/
replay, deployment-id, and role-mapping logic end-to-end against a locally generated key pair --
no real LMS needed for that layer.

## Known limitations

- **Single-instance only.** Rate-limit buckets (`src/rateLimit.js`) and the NRPS/AGS service-token
  cache (`src/lti/nrps.js`) are in-memory per process, same as the SQLite database itself (a local
  Docker volume, not a shared store). None of this is safe to run as multiple replicas behind a
  load balancer without moving all three to a shared store together.
- The four cross-service secrets (`ADMIN_SECRET`, `SESSION_SECRET`, `LTI_BRIDGE_SECRET`,
  `TENANT_ADMIN_SECRET`) are still plain env vars -- no secrets manager or rotation story yet. This
  tool's own RSA private key, the one thing actually persisted to disk, is encrypted at rest when
  `KEY_ENCRYPTION_SECRET` is set (see `src/security/keyEncryption.js`); it stays plaintext if that
  var is left unset, with a startup warning.

## Multi-deployment support

A single registration (`issuer` + `client_id`) can now launch from more than one
`deployment_id` -- not all platforms tie the two 1:1 the way Moodle's `mod_lti` does (Canvas, for
example, can mint a fresh `deployment_id` per course/account that installs the same client). The
`deployment_id` given at registration is always accepted; `POST /admin/platforms/:id/deployments`
adds more, and each registered platform's `/admin` row shows how many it has. This is groundwork
for Dynamic Registration (below), which will auto-discover additional deployments the same way.

## Not yet built

Everything in the core LTI Advantage feature set (Deep Linking, Names and Roles Provisioning,
Dynamic Registration, Assignment and Grade Services) is implemented. What isn't real-LMS-verified
yet, since this service is developed without direct access to a live Moodle/Canvas: Dynamic
Registration and AGS specifically (the manually-registered flow has been live-tested against
HTU's Moodle -- see "Status" above).
