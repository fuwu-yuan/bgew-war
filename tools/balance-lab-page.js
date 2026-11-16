/**
 * Banc d'équilibrage — code injecté DANS la page (voir balance-lab.mjs).
 *
 * Deux « commandants » scriptés (un par camp) jouent une partie complète en
 * accéléré via le vrai chemin de commandes (`executeCommand`), exactement
 * comme deux humains : même or, mêmes validations. L'IA rouge du jeu est
 * coupée pour que les deux camps soient strictement symétriques.
 *
 * Un commandant = un STYLE (poids de dépense par catégorie + placement). On
 * oppose tous les styles entre eux pour voir si un style écrase les autres,
 * combien de temps durent les parties, et si un retard se rattrape.
 */
(() => {
  const RED = 1;
  const BLUE = 2;
  const TILE = 40;
  const GW = 16;
  const GH = 22;
  const MAP_H = GH * TILE;

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Styles : poids de dépense. Le commandant achète toujours la catégorie la
   *  plus « en retard » sur son poids, et ÉCONOMISE pour elle (pas d'achat
   *  d'opportunité qui dilue le style). */
  const STYLES = {
    // Masse de soldats + niveaux, casernes posées en retrait du front.
    infantry: { w: { barracks: 3, upSoldier: 4 }, forward: false },
    // Le style de Steve : pareil, mais casernes AVANCÉES sur toute la largeur (coins compris).
    expander: { w: { barracks: 3, upSoldier: 4 }, forward: true },
    armor: { w: { factory: 4, upTank: 3, barracks: 1 }, forward: false },
    fortress: { w: { turret: 3, upTurret: 2, barracks: 2, upSoldier: 1 }, forward: false },
    air: { w: { heli: 4, upHeli: 1.5, barracks: 2, upSoldier: 1 }, forward: false },
    bomber: { w: { strike: 4, barracks: 2, upSoldier: 1 }, forward: false },
    // Le joueur complet : un peu de tout.
    mixed: {
      w: { barracks: 2, factory: 2, turret: 1, upSoldier: 2, upTank: 1, upTurret: 0.5, strike: 1, heli: 1 },
      forward: false,
      reactive: true,
    },
    // Ablations du joueur complet : le même sans UN outil. Si « sans X » fait
    // aussi bien que le complet, c'est que X ne sert à rien.
    no_heli: { w: { barracks: 2, factory: 2, turret: 1, upSoldier: 2, upTank: 1, upTurret: 0.5, strike: 1 }, forward: false, reactive: true },
    no_strike: { w: { barracks: 2, factory: 2, turret: 1, upSoldier: 2, upTank: 1, upTurret: 0.5, heli: 1 }, forward: false, reactive: true },
    no_turret: { w: { barracks: 2, factory: 2, upSoldier: 2, upTank: 1, strike: 1, heli: 1 }, forward: false },
    no_tank: { w: { barracks: 2, turret: 1, upSoldier: 2, upTurret: 0.5, strike: 1, heli: 1 }, forward: false, reactive: true },
    no_upgrade: { w: { barracks: 2, factory: 2, turret: 1, strike: 1, heli: 1 }, forward: false, reactive: true },
    // Uniquement des casernes : le plancher « zéro réflexion ».
    swarm: { w: { barracks: 1 }, forward: false },
  };
  const CAPS = { barracks: 14, factory: 6, turret: 12 };

  function makeCommander(play, BAL, f, styleName, rng) {
    const style = STYLES[styleName];
    const foe = f === RED ? BLUE : RED;
    const dir = f === RED ? 1 : -1; // sens de marche (lignes)
    const spent = {};
    for (const k of Object.keys(style.w)) spent[k] = 0;
    const log = { spent, strikes: 0, helis: 0 };
    const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const cmd = (c) => play.executeCommand(Object.assign({ type: "cmd", faction: f }, c));
    const map = () => play.map;

    /** Ligne de front du camp dans la colonne (la case la plus avancée qu'il tient). */
    function frontRow(who, c) {
      const m = map();
      if (who === RED) {
        for (let r = GH - 1; r >= 0; r--) if (m.owner[m.idx(c, r)] === RED) return r;
        return -1;
      }
      for (let r = 0; r < GH; r++) if (m.owner[m.idx(c, r)] === BLUE) return r;
      return GH;
    }
    function canBuild(c, r) {
      const m = map();
      if (c < 0 || c >= GW || r < 1 || r > GH - 2) return false;
      const i = m.idx(c, r);
      return m.isLand(c, r) && m.owner[i] === f && !play.buildingAt.has(i) && !m.hasChest(i);
    }
    function hqOf(who) {
      return play.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === who);
    }
    function count(who, type) {
      let n = 0;
      for (const b of play.buildings) if (!b.dead && b.faction === who && b.type === type) n++;
      return n;
    }
    function colStats() {
      const mine = new Array(GW).fill(0);
      const theirs = new Array(GW).fill(0);
      for (const u of play.units) {
        if (u.dead) continue;
        const c = clamp(Math.floor(u.cx / TILE), 0, GW - 1);
        const v = u.isTank ? 2.5 : 1;
        if (u.faction === f) mine[c] += v;
        else theirs[c] += v;
      }
      return { mine, theirs };
    }

    /** Axe : la colonne où l'ennemi est faible et où mon front est déjà avancé ;
     *  rappel sur la percée si mon QG est menacé. */
    function chooseAxis() {
      const hq = hqOf(f);
      if (hq) {
        let threats = 0;
        let tx = hq.cx;
        for (const u of play.units) {
          if (!u.dead && u.faction === foe && Math.hypot(u.cx - hq.cx, u.cy - hq.cy) < 240) {
            threats++;
            tx = u.cx;
          }
        }
        if (threats >= 3) return clamp(Math.floor(tx / TILE), 0, GW - 1);
      }
      const { mine, theirs } = colStats();
      let best = 8;
      let bestS = -Infinity;
      for (let c = 0; c < GW; c++) {
        const fr = frontRow(f, c);
        if (fr < 0 || fr >= GH) continue;
        const adv = f === RED ? fr : GH - 1 - fr; // avancée de mon front
        const near = (theirs[c - 1] || 0) + theirs[c] + (theirs[c + 1] || 0);
        const s = adv * 1.2 - near * 0.6 + (mine[c] || 0) * 0.05;
        if (s > bestS) {
          bestS = s;
          best = c;
        }
      }
      return best;
    }

    function place(kind) {
      const axis = play.axisCol[f];
      for (let t = 0; t < 30; t++) {
        let c;
        let back;
        if (kind === "turret") {
          c = clamp(axis + ri(-4, 4), 0, GW - 1);
          back = ri(2, 4);
        } else if (style.forward) {
          c = ri(0, GW - 1); // toute la largeur, coins compris
          back = ri(0, 1);
        } else {
          c = clamp(axis + ri(-3, 3), 0, GW - 1);
          back = kind === "factory" ? ri(3, 6) : ri(2, 5);
        }
        const fr = frontRow(f, c);
        if (fr < 0 || fr >= GH) continue;
        const r = clamp(fr - dir * back, 1, GH - 2);
        if (canBuild(c, r)) {
          cmd({ cmd: "build", kind, c, r });
          return true;
        }
      }
      const hq = hqOf(f);
      if (!hq) return false;
      for (let t = 0; t < 20; t++) {
        const c = clamp(hq.col + ri(-5, 5), 0, GW - 1);
        const r = clamp(hq.row + dir * ri(1, 6), 1, GH - 2);
        if (canBuild(c, r)) {
          cmd({ cmd: "build", kind, c, r });
          return true;
        }
      }
      return false;
    }

    /** Meilleure cible de frappe : valeur détruite (or) − mes pertes. */
    function strikeTarget() {
      const R = BAL.strike.radius;
      let best = null;
      let bestV = 0;
      const cands = [];
      for (const u of play.units) if (!u.dead && u.faction === foe) cands.push(u);
      for (const b of play.buildings) if (!b.dead && b.faction === foe && b.type !== "hq") cands.push(b);
      // échantillonne au plus 40 centres candidats
      const step = Math.max(1, Math.floor(cands.length / 40));
      for (let k = 0; k < cands.length; k += step) {
        const p = cands[k];
        let v = 0;
        for (const u of play.units) {
          if (u.dead || Math.hypot(u.cx - p.cx, u.cy - p.cy) > R) continue;
          const worth = u.isTank ? 2.5 : 1;
          const frac = Math.min(1, BAL.strike.dmgUnit / u.hp);
          const val = frac >= 1 ? worth : worth * frac * 0.5;
          v += u.faction === foe ? val : -val;
        }
        for (const b of play.buildings) {
          if (b.dead || b.type === "hq" || Math.hypot(b.cx - p.cx, b.cy - p.cy) > R) continue;
          const frac = Math.min(1, BAL.strike.dmgBuilding / b.hp);
          const worth = b.type === "factory" ? 9 : b.type === "turret" ? 6 : 5;
          const val = frac >= 1 ? worth : worth * frac * 0.5;
          v += b.faction === foe ? val : -val;
        }
        if (v > bestV) {
          bestV = v;
          best = p;
        }
      }
      // une frappe doit détruire au moins ~7 soldats-équivalents pour valoir son prix
      const need = (BAL.cost.strike / 100) * 7;
      if (!best || bestV < need) return null;
      const lead = best.isTank !== undefined ? dir * -1 * 38 * BAL.strike.delay : 0; // l'ennemi marche vers moi
      return { x: best.cx, y: clamp(best.cy + lead, TILE, MAP_H - TILE) };
    }

    function heliColumn() {
      const { theirs } = colStats();
      let best = 8;
      let bestV = -1;
      for (let c = 0; c < GW; c++) {
        const v = (theirs[c - 1] || 0) + theirs[c] + (theirs[c + 1] || 0);
        if (v > bestV) {
          bestV = v;
          best = c;
        }
      }
      return best;
    }

    const UP_KIND = { upSoldier: "soldier", upTank: "tank", upTurret: "turret", upHeli: "heli" };
    /** Voie achetée ensuite : imposée par le style (upOnly), sinon la moins avancée. */
    function upStat(kind) {
      if (style.upOnly) return style.upOnly;
      const u = play.ups[f][kind];
      return u.atk <= u.def ? "atk" : "def";
    }
    function costOf(cat) {
      if (cat === "barracks" || cat === "factory" || cat === "turret") return play.costOf(f, cat);
      if (cat === "strike") return BAL.cost.strike;
      if (cat === "heli") return BAL.cost.helico;
      const kind = UP_KIND[cat];
      const stat = upStat(kind);
      const u = BAL.upgrade[kind][stat];
      return Math.round(u.base * Math.pow(play.ups[f][kind][stat], u.exp));
    }
    function eligible(cat) {
      // Tourelles « à la demande » : un joueur sensé n'en pose que s'il subit
      // (territoire en recul ou hélico ennemi en vol), pas à l'aveugle.
      if (cat === "turret" && style.reactive) {
        const share = play.map.share(f);
        const enemyHeli = play.helis.some((h) => !h.dead && h.faction === foe);
        if (share > 0.47 && !enemyHeli) return false;
      }
      if (cat === "barracks" || cat === "factory" || cat === "turret") return count(f, cat) < CAPS[cat];
      if (cat === "upTank") return count(f, "factory") > 0;
      if (cat === "upTurret") return count(f, "turret") > 0;
      if (cat === "upHeli") return log.helis > 0;
      if (cat === "heli") return play.helis.filter((h) => !h.dead && h.faction === f).length < BAL.heli.max;
      return true;
    }

    function think() {
      const axis = chooseAxis();
      if (play.axisCol[f] !== axis) cmd({ cmd: "axis", col: axis });

      // catégories triées par retard (dépensé / poids)
      const cats = Object.keys(style.w)
        .filter(eligible)
        .sort((a, b) => spent[a] / style.w[a] - spent[b] / style.w[b]);
      for (const cat of cats) {
        const cost = costOf(cat);
        if (cat === "strike") {
          if (play.gold[f] < cost) return; // économise
          const t = strikeTarget();
          if (!t) continue; // pas de cible : passe à la suite, la banque reste
          cmd({ cmd: "strike", x: Math.round(t.x), y: Math.round(t.y) });
          spent.strike += cost;
          log.strikes++;
          return;
        }
        // garde la banque de frappe si le style frappe
        const bank = style.w.strike && cat !== "strike" ? BAL.cost.strike * 0.6 : 0;
        if (play.gold[f] < cost + bank) return; // économise pour la catégorie en retard
        if (cat === "heli") {
          cmd({ cmd: "helico", x: heliColumn() * TILE + TILE / 2 });
          log.helis++;
        } else if (cat === "barracks" || cat === "factory" || cat === "turret") {
          if (!place(cat)) continue;
        } else {
          cmd({ cmd: "upgrade", kind: UP_KIND[cat], stat: upStat(UP_KIND[cat]) });
        }
        spent[cat] += cost;
        return;
      }
    }
    return { think, log };
  }

  /** Démarre une partie fraîche, reproductible (seed), IA du jeu coupée. */
  function startMatch(seed, overrides) {
    const w = window.__bgewwar;
    const play = w.steps.play;
    const BAL = w.balance;
    if (!window.__balBase) window.__balBase = JSON.parse(JSON.stringify(BAL));
    // remet la base puis applique la variante
    const deep = (dst, src) => {
      for (const k of Object.keys(src)) {
        if (src[k] && typeof src[k] === "object") deep(dst[k], src[k]);
        else dst[k] = src[k];
      }
    };
    deep(BAL, window.__balBase);
    if (overrides) deep(BAL, overrides);
    Math.random = mulberry32(seed);
    // coupe la boucle temps réel et l'IA du jeu : c'est le labo qui avance la sim
    play.update = () => {};
    play.draw = () => {};
    play.redBrain = () => {};
    play.redPanic = () => {};
    w.board.moveToStep("game", { difficulty: "easy" });
    play.gold[RED] = BAL.startGold;
    play.gold[BLUE] = BAL.startGold;
    return { play, BAL };
  }

  /**
   * Duel isolé : deux armées posées face à face au milieu de la carte, sans
   * production ni tourelles (tous les bâtiments sauf les QG sont retirés).
   * Sert à mesurer la valeur d'échange réelle des unités (ex. combien de
   * soldats pour battre un tank). Renvoie les survivants de chaque camp.
   */
  function duel(opts) {
    const { play } = startMatch(opts.seed, opts.overrides);
    for (const b of play.buildings) if (b.type !== "hq") b.dead = true;
    for (const u of play.units) u.dead = true;
    play.sweepDead();
    play.buildingAt.clear();
    play.hqDefenseUsed = { [RED]: 99, [BLUE]: 99 }; // pas de vague de défense dans un duel
    play.counts[RED] = { soldiers: 0, tanks: 0 };
    play.counts[BLUE] = { soldiers: 0, tanks: 0 };
    const rng = mulberry32(opts.seed);
    const put = (f, army, y0) => {
      // niveaux : { atk, def } par branche (défaut 1/1)
      play.ups[f].soldier = { atk: army.atk || 1, def: army.def || 1 };
      play.ups[f].tank = { atk: army.tankAtk || 1, def: army.tankDef || 1 };
      for (let i = 0; i < (army.soldiers || 0); i++) play.spawnSoldier(f, 200 + rng() * 240, y0 + (rng() - 0.5) * 60);
      for (let i = 0; i < (army.tanks || 0); i++) play.spawnTank(f, 200 + rng() * 240, y0 + (rng() - 0.5) * 60);
    };
    put(RED, opts.red, MAP_H / 2 - 110);
    put(BLUE, opts.blue, MAP_H / 2 + 110);
    const alive = (f) => play.units.filter((u) => !u.dead && u.faction === f).length;
    let t = 0;
    for (; t < 60 * 90 && alive(RED) > 0 && alive(BLUE) > 0; t++) play.simStep();
    return { red: alive(RED), blue: alive(BLUE), t: Math.round(t / 60) };
  }

  window.__lab = {
    styles: Object.keys(STYLES),
    duel,
    /** Joue une partie entière ; renvoie le verdict et la chronologie. */
    begin(opts) {
      // styles supplémentaires/surchargés fournis par le banc (ablations, essais)
      if (opts.styleDefs) Object.assign(STYLES, opts.styleDefs);
      const { play, BAL } = startMatch(opts.seed, opts.overrides);
      const rng = mulberry32(opts.seed ^ 0x9e3779b9);
      // Comptabilité des outils : dégâts infligés par les tourelles et les
      // hélicos, soldats-équivalents tués par les frappes (rendement par or).
      const tools = { [RED]: { turretDmg: 0, heliDmg: 0, strikeKills: 0, strikeOwn: 0 }, [BLUE]: { turretDmg: 0, heliDmg: 0, strikeKills: 0, strikeOwn: 0 } };
      const fire0 = Object.getPrototypeOf(play).fireBullet;
      play.fireBullet = function (x, y, target, dmg, f, big, splash) {
        const tile = play.buildingAt.get(play.map.idx(Math.floor(x / TILE), Math.floor((y + 10) / TILE)));
        if (tile && tile.type === "turret" && tile.cx === x && tile.faction === f) tools[f].turretDmg += Math.min(dmg, target.hp);
        else if (play.helis.some((h) => h.cx === x && h.cy === y)) tools[f].heliDmg += Math.min(dmg, target.hp);
        return fire0.call(play, x, y, target, dmg, f, big, splash);
      };
      const strike0 = Object.getPrototypeOf(play).applyStrike;
      play.applyStrike = function (x, y, f) {
        const val = (who) => {
          let v = 0;
          for (const u of play.units) if (!u.dead && u.faction === who) v += u.isTank ? 6 : 1;
          return v;
        };
        const foe = f === RED ? BLUE : RED;
        const e0 = val(foe);
        const m0 = val(f);
        strike0.call(play, x, y, f);
        tools[f].strikeKills += e0 - val(foe);
        tools[f].strikeOwn += m0 - val(f);
      };
      this.tools = tools;
      this.m = {
        play,
        BAL,
        red: makeCommander(play, BAL, RED, opts.red, rng),
        blue: makeCommander(play, BAL, BLUE, opts.blue, rng),
        tick: 0,
        timeline: [],
        lead: 0,
        leadChanges: 0,
        minShare: { [RED]: 1, [BLUE]: 1 },
        maxTicks: (opts.maxSeconds || 900) * 60,
        peakUnits: 0,
      };
    },
    /** Avance d'au plus `n` ticks ; renvoie le résultat si la partie est finie. */
    run(n) {
      const m = this.m;
      const play = m.play;
      for (let i = 0; i < n && !play.ended && m.tick < m.maxTicks; i++, m.tick++) {
        if (m.tick % 30 === 0 && m.tick >= 120) {
          // alterne qui pense en premier pour ne favoriser aucun camp
          if ((m.tick / 30) % 2 === 0) {
            m.red.think();
            m.blue.think();
          } else {
            m.blue.think();
            m.red.think();
          }
        }
        play.simStep();
        if (m.tick % 300 === 0) {
          const share = play.map.share(BLUE);
          m.minShare[BLUE] = Math.min(m.minShare[BLUE], share);
          m.minShare[RED] = Math.min(m.minShare[RED], 1 - share);
          const lead = share > 0.55 ? BLUE : share < 0.45 ? RED : m.lead;
          if (lead !== m.lead) {
            if (m.lead !== 0) m.leadChanges++;
            m.lead = lead;
          }
          let ru = 0;
          let bu = 0;
          for (const u of play.units) {
            if (u.dead) continue;
            if (u.faction === RED) ru++;
            else bu++;
          }
          m.peakUnits = Math.max(m.peakUnits, ru + bu);
          m.timeline.push([Math.round(play.elapsed), +share.toFixed(2), ru, bu, Math.round(play.gold[RED]), Math.round(play.gold[BLUE])]);
        }
      }
      if (!play.ended && m.tick < m.maxTicks) return null;
      const hq = (f) => {
        const b = play.buildings.find((x) => x.type === "hq" && x.faction === f);
        return b && !b.dead ? Math.max(0, b.hp / b.maxHp) : 0;
      };
      const winner = play.ended ? (play.endData && play.endData.win ? BLUE : RED) : 0;
      return {
        winner,
        t: Math.round(play.elapsed),
        share: +play.map.share(BLUE).toFixed(2),
        leadChanges: m.leadChanges,
        // « remontée » : le vainqueur est tombé sous 35 % de la carte à un moment
        comeback: winner ? m.minShare[winner] < 0.35 : false,
        minShareWinner: winner ? +m.minShare[winner].toFixed(2) : null,
        hq: { red: +hq(RED).toFixed(2), blue: +hq(BLUE).toFixed(2) },
        levels: { red: play.ups[RED], blue: play.ups[BLUE] },
        logs: { red: m.red.log, blue: m.blue.log },
        tools: { red: this.tools[RED], blue: this.tools[BLUE] },
        peakUnits: m.peakUnits,
        timeline: m.timeline,
      };
    },
  };
})();
