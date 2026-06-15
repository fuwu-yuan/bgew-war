/* ------------------------------------------------------------------ *
 * "MES STATS" — a DOM overlay rendered on top of the game canvas.
 *
 * Built as plain DOM (not canvas) on purpose: it can use accented French
 * text freely (the canvas font 'Black Ops One' has no accented glyphs),
 * and styled tables/cards are far cleaner in HTML.
 *
 * Self-contained: injects its own <style> once, builds its own elements,
 * and reads stats lazily on open. Exposes openStatsModal() / closeStatsModal().
 * ------------------------------------------------------------------ */
import { RED } from "../globals";
import { formatTime } from "../utils";
import { currentUser, displayName, loadMyMatches, loadMyRank, type MatchRecord, type PlayerRank } from "../firebase";

const STYLE_ID = "bgew-stats-style";
const OVERLAY_ID = "bgew-stats-overlay";

const CSS = `
#${OVERLAY_ID} {
  position: fixed; inset: 0; z-index: 9999;
  display: none; align-items: center; justify-content: center;
  background: rgba(4, 10, 22, 0.78);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-tap-highlight-color: transparent;
  padding: 16px;
}
#${OVERLAY_ID}.open { display: flex; }
#${OVERLAY_ID} .bs-card {
  position: relative;
  width: 100%; max-width: 560px; max-height: 90vh;
  display: flex; flex-direction: column;
  background: linear-gradient(160deg, #132b45 0%, #0a1428 100%);
  border: 2px solid rgba(127, 209, 255, 0.45);
  border-radius: 18px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6);
  color: #e8f2fc;
  overflow: hidden;
}
#${OVERLAY_ID} .bs-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 22px 14px;
  border-bottom: 1px solid rgba(127, 209, 255, 0.22);
}
#${OVERLAY_ID} .bs-title {
  font-family: 'Black Ops One', sans-serif;
  font-size: 26px; letter-spacing: 1px;
  color: #ffd95e; margin: 0;
}
#${OVERLAY_ID} .bs-sub { font-size: 13px; color: #9fc3e4; margin-top: 2px; }
#${OVERLAY_ID} .bs-close {
  flex: 0 0 auto; width: 34px; height: 34px; border-radius: 50%;
  border: 2px solid #ff8b7a; background: rgba(255, 100, 90, 0.18);
  color: #fff; font-size: 18px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s;
}
#${OVERLAY_ID} .bs-close:hover { background: rgba(255, 100, 90, 0.4); }
#${OVERLAY_ID} .bs-body { padding: 18px 22px 24px; overflow-y: auto; }
#${OVERLAY_ID} .bs-msg { font-size: 15px; line-height: 1.5; color: #cfe1f4; text-align: center; padding: 30px 10px; }
#${OVERLAY_ID} .bs-msg strong { color: #7fd1ff; }
#${OVERLAY_ID} .bs-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 22px;
}
#${OVERLAY_ID} .bs-stat {
  background: rgba(10, 25, 45, 0.6);
  border: 1px solid rgba(127, 209, 255, 0.2);
  border-radius: 12px; padding: 12px 10px; text-align: center;
}
#${OVERLAY_ID} .bs-stat .v { font-size: 24px; font-weight: 700; color: #ffd95e; }
#${OVERLAY_ID} .bs-stat .l { font-size: 11px; color: #9fc3e4; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
#${OVERLAY_ID} .bs-stat.win .v { color: #7fd1ff; }
#${OVERLAY_ID} .bs-stat.loss .v { color: #ff8b7a; }
#${OVERLAY_ID} .bs-sectitle {
  font-family: 'Black Ops One', sans-serif;
  font-size: 15px; color: #ffd95e; margin: 6px 0 10px; letter-spacing: 0.5px;
}
#${OVERLAY_ID} table { width: 100%; border-collapse: collapse; font-size: 13px; }
#${OVERLAY_ID} th {
  text-align: left; font-weight: 600; color: #9fc3e4; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.5px;
  padding: 6px 6px; border-bottom: 1px solid rgba(127, 209, 255, 0.22);
}
#${OVERLAY_ID} td { padding: 7px 6px; border-bottom: 1px solid rgba(127, 209, 255, 0.1); }
#${OVERLAY_ID} td.num, #${OVERLAY_ID} th.num { text-align: right; }
#${OVERLAY_ID} .bs-res { font-weight: 700; }
#${OVERLAY_ID} .bs-res.v { color: #7fd1ff; }
#${OVERLAY_ID} .bs-res.d { color: #ff8b7a; }
#${OVERLAY_ID} .bs-camp.red { color: #ff8b7a; }
#${OVERLAY_ID} .bs-camp.blue { color: #7fd1ff; }
`;

let overlay: HTMLDivElement | null = null;
let body: HTMLDivElement | null = null;
let subEl: HTMLDivElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
let loadToken = 0;

function ensureBuilt(): void {
  if (overlay) return;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const card = document.createElement("div");
  card.className = "bs-card";

  const head = document.createElement("div");
  head.className = "bs-head";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.className = "bs-title";
  title.textContent = "MES STATS";
  subEl = document.createElement("div");
  subEl.className = "bs-sub";
  titleWrap.appendChild(title);
  titleWrap.appendChild(subEl);

  const close = document.createElement("button");
  close.className = "bs-close";
  close.setAttribute("aria-label", "Fermer");
  close.textContent = "✕"; // ✕
  close.addEventListener("click", closeStatsModal);

  head.appendChild(titleWrap);
  head.appendChild(close);

  body = document.createElement("div");
  body.className = "bs-body";

  card.appendChild(head);
  card.appendChild(body);
  overlay.appendChild(card);

  // Click on the dark backdrop (not the card) closes.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeStatsModal();
  });

  document.body.appendChild(overlay);
}

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function statCard(value: string | number, label: string, mod = ""): string {
  return `<div class="bs-stat ${mod}"><div class="v">${escHtml(String(value))}</div><div class="l">${escHtml(label)}</div></div>`;
}

function renderConnected(rank: PlayerRank | null, matches: MatchRecord[]): string {
  const e = rank?.entry;
  const wins = e?.wins ?? 0;
  const losses = e?.losses ?? 0;
  const games = e?.games ?? wins + losses;
  const pct = games > 0 ? Math.round((wins / games) * 100) : 0;
  const best = e?.bestTime != null ? formatTime(e.bestTime) : "--";

  let html = `<div class="bs-grid">`;
  html += statCard(wins, "Victoires", "win");
  html += statCard(losses, "Defaites", "loss");
  html += statCard(games, "Parties");
  html += statCard(`${pct}%`, "Reussite");
  html += statCard(best, "Meilleur temps");
  html += statCard(rank ? `#${rank.rank}` : "--", "Classement");
  html += `</div>`;

  html += `<div class="bs-sectitle">DERNIERES PARTIES</div>`;
  if (matches.length === 0) {
    html += `<div class="bs-msg">Aucune partie multi enregistree pour l'instant.</div>`;
    return html;
  }

  html += `<table><thead><tr>
    <th>Resultat</th><th>Camp</th>
    <th class="num">Duree</th><th class="num">Territoire</th>
    <th class="num">Abattus</th><th class="num">Pertes</th>
  </tr></thead><tbody>`;
  for (const m of matches) {
    const resCls = m.win ? "v" : "d";
    const resTxt = m.win ? "VICTOIRE" : "DEFAITE";
    const isRed = m.faction === RED;
    const campCls = isRed ? "red" : "blue";
    const campTxt = isRed ? "ROUGE" : "BLEU";
    const share = `${Math.round((m.share || 0) * 100)}%`;
    html += `<tr>
      <td><span class="bs-res ${resCls}">${resTxt}</span></td>
      <td><span class="bs-camp ${campCls}">${campTxt}</span></td>
      <td class="num">${formatTime(m.time)}</td>
      <td class="num">${share}</td>
      <td class="num">${m.kills}</td>
      <td class="num">${m.losses}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

export function openStatsModal(): void {
  ensureBuilt();
  if (!overlay || !body || !subEl) return;

  overlay.classList.add("open");

  if (!escHandler) {
    escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeStatsModal();
    };
    window.addEventListener("keydown", escHandler);
  }

  const user = currentUser();
  if (!user || user.isAnonymous) {
    subEl.textContent = "Non connecte";
    body.innerHTML = `<div class="bs-msg">
      Vous n'etes pas connecte.<br>
      Connectez-vous avec <strong>Google</strong> depuis le menu pour suivre vos
      victoires, votre classement et l'historique de vos parties multijoueur.
    </div>`;
    return;
  }

  subEl.textContent = displayName(user);
  body.innerHTML = `<div class="bs-msg">Chargement…</div>`;

  const token = ++loadToken;
  Promise.all([loadMyRank(), loadMyMatches(20)])
    .then(([rank, matches]) => {
      if (token !== loadToken || !body) return; // a newer open/close superseded us
      body.innerHTML = renderConnected(rank, matches);
    })
    .catch(() => {
      if (token !== loadToken || !body) return;
      body.innerHTML = `<div class="bs-msg">Statistiques indisponibles pour le moment.</div>`;
    });
}

export function closeStatsModal(): void {
  loadToken++; // cancel any in-flight render
  overlay?.classList.remove("open");
  if (escHandler) {
    window.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
}
