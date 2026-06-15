# BGEW WAR — Cloud Functions (ranked validation)

`submitMatchResult` is an authenticated **callable** function. Each player sends
their own match report; the function pairs the two reports for one match id and
records the result only when they agree and pass the anti-cheat checks
(see `index.js`). Stats are written by this function alone — the Firestore rules
forbid clients from touching `wins/losses/games/bestTime`.

## Prerequisites
- The Firebase project must be on the **Blaze (pay-as-you-go)** plan. Cloud
  Functions cannot be deployed on the free Spark plan. (Idle cost is ~0; you pay
  per invocation, which for this game is negligible.)
- Firebase CLI: `npm i -g firebase-tools` then `firebase login`.

## Deploy
From the repo root (project is `bgew-war`, see `.firebaserc`):

```bash
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules
```

The callable runs in the default region **us-central1** — the web client uses
`getFunctions(app)` with the same default, so they match. If you change the
region, set it in both places.

## Local check (optional)
```bash
node --check functions/index.js          # syntax
firebase emulators:start --only functions,firestore   # full local run
```

## Data model
- `users/{uid}` — profile + stats (function-written).
- `users/{uid}/matches/{id}` — per-player history (function-written, owner-readable).
- `matches/{matchId}` — the single-use validation doc ("match token"):
  `status: open|resolved|disputed`, the two `reports`, and `reasons` when disputed.
