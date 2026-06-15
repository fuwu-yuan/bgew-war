/**
 * BGEW WAR — ranked match validation.
 *
 * Stats are NEVER written by the client. Each player calls `submitMatchResult`
 * with their own view of the outcome; the function correlates the two reports
 * for one match id and only records the result when they AGREE and pass the
 * anti-cheat checks. The match id is single-use (a "match token"): once the
 * second report resolves or disputes it, no further report is accepted.
 *
 * Anti-cheat performed here (server-trusted, can't be faked by a client):
 *   - both reports authenticated, from two DISTINCT non-anonymous accounts;
 *   - exactly one winner / one loser, on opposite factions;
 *   - durations agree (within a tolerance) and meet a minimum;
 *   - the two callers are NOT on the same public IP (compared server-side);
 *   - each account reports a match id once (replay / double-count blocked).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

const MIN_DURATION = 20; // s
const TIME_TOLERANCE = 10; // s — clocks/latency differ a little between clients
const MATCH_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function callerIp(request) {
  const xff = request.rawRequest && request.rawRequest.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return (request.rawRequest && request.rawRequest.ip) || "";
}

function hashIp(ip) {
  return ip ? crypto.createHash("sha256").update("bgew-war:" + ip).digest("hex") : "";
}

/** Apply a validated report to a user doc + append their match history row. */
function writeStats(tx, ref, snap, r) {
  const prev = snap.exists ? snap.data() : {};
  const bestPrev = typeof prev.bestTime === "number" ? prev.bestTime : null;
  const bestTime = r.win ? (bestPrev === null ? r.time : Math.min(bestPrev, r.time)) : bestPrev;
  tx.set(
    ref,
    {
      wins: FieldValue.increment(r.win ? 1 : 0),
      losses: FieldValue.increment(r.win ? 0 : 1),
      games: FieldValue.increment(1),
      bestTime: bestTime,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  tx.set(ref.collection("matches").doc(), {
    win: r.win,
    time: r.time,
    share: Math.round(r.share * 1000) / 1000,
    kills: r.kills,
    losses: r.losses,
    faction: r.faction,
    createdAt: FieldValue.serverTimestamp(),
  });
}

exports.submitMatchResult = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  if (auth.token.firebase && auth.token.firebase.sign_in_provider === "anonymous") {
    throw new HttpsError("permission-denied", "Compte requis.");
  }
  const uid = auth.uid;
  const d = request.data || {};

  const matchId = String(d.matchId || "");
  const opponentUid = String(d.opponentUid || "");
  if (!MATCH_ID_RE.test(matchId)) throw new HttpsError("invalid-argument", "matchId");
  if (!opponentUid || opponentUid === uid) throw new HttpsError("invalid-argument", "opponentUid");

  const win = d.win === true;
  const time = Math.round(Number(d.time));
  const share = Number(d.share);
  const kills = Math.max(0, Math.min(100000, Math.round(Number(d.kills) || 0)));
  const losses = Math.max(0, Math.min(100000, Math.round(Number(d.losses) || 0)));
  const faction = d.faction === 1 ? 1 : d.faction === 2 ? 2 : 0;
  if (!Number.isFinite(time) || time <= 0 || time > 86400) throw new HttpsError("invalid-argument", "time");
  if (!(share >= 0 && share <= 1)) throw new HttpsError("invalid-argument", "share");
  if (faction === 0) throw new HttpsError("invalid-argument", "faction");

  const ipHash = hashIp(callerIp(request));
  const report = { uid, opponentUid, win, time, share, kills, losses, faction, ipHash, at: Timestamp.now() };
  const matchRef = db.collection("matches").doc(matchId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(matchRef);

    // First report for this match → open it and wait for the opponent.
    if (!snap.exists) {
      tx.set(matchRef, {
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
        players: [uid],
        reports: { [uid]: report },
      });
      return { status: "pending", recorded: false };
    }

    const m = snap.data();
    // Idempotent: a client polling its own already-filed report.
    if (m.reports && m.reports[uid]) {
      return { status: m.status === "open" ? "pending" : m.status, recorded: m.status === "resolved" };
    }
    // Token already spent, or somehow a third participant.
    if (m.status !== "open") throw new HttpsError("failed-precondition", "Match deja clos.");
    if (!Array.isArray(m.players) || m.players.length !== 1) {
      throw new HttpsError("failed-precondition", "Match invalide.");
    }

    const other = m.reports[m.players[0]];

    // Read both user docs BEFORE any write (Firestore transaction rule).
    const myRef = db.collection("users").doc(uid);
    const otherRef = db.collection("users").doc(other.uid);
    const [mySnap, otherSnap] = await Promise.all([tx.get(myRef), tx.get(otherRef)]);

    // Cross-check the two reports.
    const reasons = [];
    if (other.uid === uid) reasons.push("meme_joueur");
    if (other.opponentUid !== uid || report.opponentUid !== other.uid) reasons.push("appariement");
    if (other.win === report.win) reasons.push("desaccord_resultat");
    if (other.faction === report.faction) reasons.push("meme_faction");
    if (Math.abs(other.time - report.time) > TIME_TOLERANCE) reasons.push("duree_incoherente");
    if (report.time < MIN_DURATION || other.time < MIN_DURATION) reasons.push("trop_courte");
    if (ipHash && other.ipHash && ipHash === other.ipHash) reasons.push("meme_reseau");

    const ok = reasons.length === 0;
    const status = ok ? "resolved" : "disputed";
    tx.update(matchRef, {
      status,
      players: FieldValue.arrayUnion(uid),
      [`reports.${uid}`]: report,
      reasons,
      resolvedAt: FieldValue.serverTimestamp(),
    });
    if (ok) {
      writeStats(tx, myRef, mySnap, report);
      writeStats(tx, otherRef, otherSnap, other);
    }
    return { status, recorded: ok, reason: reasons[0] };
  });
});
