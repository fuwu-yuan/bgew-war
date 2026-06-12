import {
  getAnalytics,
  isSupported,
  logEvent,
  setUserId,
  setUserProperties,
  type Analytics,
} from "firebase/analytics";
import { onAuthStateChanged } from "firebase/auth";
import { app, auth } from "./firebase";
import { GAME_VERSION } from "./globals";

/**
 * Instrumentation Firebase / Google Analytics 4 du jeu.
 *
 * - `?firebase=off` dans l'URL coupe tout (tests, vie privée).
 * - `isSupported()` est async (Safari privé, in-app browsers… renvoient
 *   false) : tant qu'il n'a pas résolu, les events sont mis en file et
 *   rejoués au flush. Aucun appel ne lève — l'analytics ne doit jamais
 *   casser le jeu.
 * - Tous les noms d'events sont snake_case (convention GA4). Les params
 *   restent < 25 par event, valeurs courtes : GA4 tronque au-delà.
 */

const DISABLED = new URLSearchParams(window.location.search).get("firebase") === "off";

type Params = Record<string, string | number | boolean | undefined>;

let analytics: Analytics | null = null;
let ready = false;
const queue: { name: string; params?: Params }[] = [];

if (!DISABLED) {
  isSupported()
    .then((ok) => {
      if (!ok) return;
      analytics = getAnalytics(app);
      ready = true;
      setUserProperties(analytics, { game_version: GAME_VERSION });
      // Rejoue ce qui s'est passé avant que le SDK soit prêt (app_open…)
      for (const e of queue.splice(0)) logEvent(analytics, e.name, e.params);
      // Attribution : associe les events à l'UID dès qu'il est connu.
      onAuthStateChanged(auth, (user) => {
        setUserId(analytics!, user && !user.isAnonymous ? user.uid : null);
      });
    })
    .catch(() => undefined);
}

/** Logue un event GA4. No-op si désactivé ; mis en file si pas encore prêt. */
export function track(name: string, params?: Params): void {
  if (DISABLED) return;
  if (ready && analytics) {
    logEvent(analytics, name, params);
  } else if (queue.length < 200) {
    queue.push({ name, params });
  }
}

/** Vue d'écran (menu, game, end…) — alimente le rapport "screens" de GA4. */
export function trackScreen(screen: string): void {
  track("screen_view", { firebase_screen: screen, firebase_screen_class: screen });
}
