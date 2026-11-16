/**
 * Banc d'essai — code injecté DANS la page du jeu (balance-lab.mjs, train.mjs…).
 *
 * Deux COMMANDANTS (src/commander.ts, le même cerveau que l'IA du jeu) jouent
 * une partie complète, un par camp, chacun avec son génome, par le vrai chemin
 * de commandes (`executeCommand`) : même or, mêmes validations que deux humains.
 * L'IA rouge du jeu est coupée pour que les deux camps soient symétriques.
 *
 * Deux façons d'avancer la simulation :
 *   - `run(n)`  : le banc avance n ticks d'un coup (sans affichage, le plus rapide) ;
 *   - `visual`  : la page avance elle-même `speed` ticks par image et DESSINE la
 *                 bataille (entraînement en vitrine, on lit le résultat avec `poll()`).
 */
(() => {
  const RED = 1;
  const BLUE = 2;
  const TILE = 40;
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

  /* ------------------------------------------------------------------ *
   * Styles fixes : des génomes écrits à la main, un par façon de jouer.
   * Ils servent d'étalons pour l'équilibrage et d'adversaires d'entraînement.
   * ------------------------------------------------------------------ */
  const W0 = { barracks: 0, factory: 0, turret: 0, strike: 0, heli: 0, soldierAtk: 0, soldierDef: 0, tankAtk: 0, tankDef: 0, turretAtk: 0, turretDef: 0, heliAtk: 0, heliDef: 0 };
  /** Style fixe : pas de réaction à l'adversaire, pas de banque (sauf si le style frappe). */
  function fixed(w, o = {}) {
    return Object.assign(
      {
        bank: w.strike ? 36 : 0,
        strikeMin: 8,
        turretShare: 1,
        heliMaxAA: 6,
        backMin: 2,
        backSpan: 3,
        spread: 3,
        axAdvance: 1.2,
        axEnemy: 0.6,
        axisHold: 0,
        defendRadius: 240,
        ecoUntil: 0,
        ecoBoost: 1,
        vsTanks: 1,
        vsMass: 1,
        vsAir: 1,
        maxBarracks: 14,
        maxFactories: 6,
        maxTurrets: 12,
      },
      o,
      { w: Object.assign({}, W0, w) }
    );
  }
  const FORWARD = { backMin: 0, backSpan: 1, spread: 8 }; // casernes avancées, toute la largeur
  const REACTIVE = { turretShare: 0.47 }; // tourelles seulement sous pression
  const ALL = { barracks: 2, factory: 2, turret: 1, soldierAtk: 1, soldierDef: 1, tankAtk: 0.5, tankDef: 0.5, turretAtk: 0.25, turretDef: 0.25, strike: 1, heli: 1 };
  const without = (keys) => {
    const w = Object.assign({}, ALL);
    for (const k of keys) delete w[k];
    return w;
  };
  const STYLES = {
    // Masse de soldats + niveaux, casernes en retrait du front.
    infantry: fixed({ barracks: 3, soldierAtk: 2, soldierDef: 2 }),
    // Le style de Steve : pareil, casernes AVANCÉES sur toute la largeur (coins compris).
    expander: fixed({ barracks: 3, soldierAtk: 2, soldierDef: 2 }, FORWARD),
    armor: fixed({ factory: 4, tankAtk: 1.5, tankDef: 1.5, barracks: 1 }),
    fortress: fixed({ turret: 3, turretAtk: 1, turretDef: 1, barracks: 2, soldierAtk: 0.5, soldierDef: 0.5 }),
    air: fixed({ heli: 4, heliAtk: 0.75, heliDef: 0.75, barracks: 2, soldierAtk: 0.5, soldierDef: 0.5 }),
    bomber: fixed({ strike: 4, barracks: 2, soldierAtk: 0.5, soldierDef: 0.5 }),
    // Le joueur complet : un peu de tout, tourelles à la demande.
    mixed: fixed(ALL, REACTIVE),
    // Ablations du joueur complet : le même sans UN outil. Si « sans X » fait
    // aussi bien que le complet, c'est que X ne sert à rien.
    no_heli: fixed(without(["heli"]), REACTIVE),
    no_strike: fixed(without(["strike"]), REACTIVE),
    no_turret: fixed(without(["turret", "turretAtk", "turretDef"])),
    no_tank: fixed(without(["factory", "tankAtk", "tankDef"]), REACTIVE),
    no_upgrade: fixed(without(["soldierAtk", "soldierDef", "tankAtk", "tankDef", "turretAtk", "turretDef"]), REACTIVE),
    // Une seule voie d'amélioration : la force seule, la défense seule.
    inf_atk: fixed({ barracks: 3, soldierAtk: 4 }),
    inf_def: fixed({ barracks: 3, soldierDef: 4 }),
    // Uniquement des casernes : le plancher « zéro réflexion ».
    swarm: fixed({ barracks: 1 }),
  };

  /** Nom de style, ou génome (complet ou partiel) → génome valide. */
  function resolve(g) {
    const ai = window.__bgewwar.ai;
    if (typeof g === "string") {
      if (!STYLES[g]) throw new Error(`style inconnu : ${g}`);
      return ai.sanitizeGenome(STYLES[g]);
    }
    return ai.sanitizeGenome(g);
  }

  /** Démarre une partie fraîche, reproductible (seed), IA du jeu coupée. */
  function startMatch(seed, overrides, visual) {
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
    // coupe la boucle temps réel et l'IA du jeu : c'est le banc qui avance la sim
    play.update = () => {};
    if (!visual) play.draw = () => {};
    else delete play.draw; // retour au dessin normal (prototype)
    w.board.moveToStep("game", { difficulty: "easy" });
    play.aiOff = true; // les deux camps sont joués par les commandants du banc
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
    const { play } = startMatch(opts.seed, opts.overrides, false);
    for (const b of play.buildings) if (b.type !== "hq") b.dead = true;
    for (const u of play.units) u.dead = true;
    play.sweepDead();
    play.buildingAt.clear();
    play.hqDefenseUsed = { [RED]: 99, [BLUE]: 99 };
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
    styleGenome: (name) => resolve(name),
    duel,

    /**
     * Lance une partie. opts : { red, blue (nom de style ou génome), seed,
     * overrides (BAL), styleDefs, maxSeconds, visual, speed }.
     */
    begin(opts) {
      if (opts.styleDefs) for (const k of Object.keys(opts.styleDefs)) STYLES[k] = fixed(opts.styleDefs[k].w || {}, opts.styleDefs[k]);
      const visual = !!opts.visual;
      const { play, BAL } = startMatch(opts.seed, opts.overrides, visual);
      const rng = mulberry32(opts.seed ^ 0x9e3779b9);
      const ai = window.__bgewwar.ai;
      const view = play.battleView();
      const issue = (c) => play.executeCommand(c);

      // Comptabilité des outils : dégâts infligés par les tourelles et les
      // hélicos, soldats-équivalents tués par les frappes (rendement par or).
      const tools = { [RED]: { turretDmg: 0, heliDmg: 0, strikeKills: 0, strikeOwn: 0 }, [BLUE]: { turretDmg: 0, heliDmg: 0, strikeKills: 0, strikeOwn: 0 } };
      if (!visual) {
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
            for (const u of play.units) if (!u.dead && u.faction === who) v += u.isTank ? 5 : 1;
            return v;
          };
          const foe = f === RED ? BLUE : RED;
          const e0 = val(foe);
          const m0 = val(f);
          strike0.call(play, x, y, f);
          tools[f].strikeKills += e0 - val(foe);
          tools[f].strikeOwn += m0 - val(f);
        };
      } else {
        delete play.fireBullet;
        delete play.applyStrike;
      }

      const m = {
        play,
        BAL,
        tools,
        red: new ai.Commander(view, RED, resolve(opts.red), issue, rng),
        blue: new ai.Commander(view, BLUE, resolve(opts.blue), issue, rng),
        tick: 0,
        timeline: [],
        lead: 0,
        leadChanges: 0,
        minShare: { [RED]: 1, [BLUE]: 1 },
        maxTicks: (opts.maxSeconds || 900) * 60,
        peakUnits: 0,
        result: null,
      };
      this.m = m;

      if (visual) {
        // La page avance la sim elle-même, `speed` ticks par image, et dessine.
        const speed = Math.max(1, opts.speed || 4);
        play.update = () => {
          if (this.m !== m || m.result) return;
          for (let i = 0; i < speed && !m.result; i++) this.step1();
          play.bringToFront();
        };
      }
    },

    /** Un tick : les commandants pensent toutes les 0,5 s, puis la sim avance. */
    step1() {
      const m = this.m;
      const play = m.play;
      if (play.ended || m.tick >= m.maxTicks) {
        if (!m.result) m.result = this.finish();
        return;
      }
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
      m.tick++;
    },

    finish() {
      const m = this.m;
      const play = m.play;
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
        logs: { red: { spent: m.red.spent }, blue: { spent: m.blue.spent } },
        tools: { red: m.tools[RED], blue: m.tools[BLUE] },
        peakUnits: m.peakUnits,
        timeline: m.timeline,
      };
    },

    /** Sans affichage : avance d'au plus `n` ticks ; renvoie le résultat si la partie est finie. */
    run(n) {
      const m = this.m;
      for (let i = 0; i < n && !m.result; i++) this.step1();
      return m.result;
    },

    /** Mode vitrine : la partie est-elle finie ? (résultat ou null) */
    poll() {
      return this.m ? this.m.result : null;
    },
  };
})();
