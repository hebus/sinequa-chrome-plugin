// Page d'arrière-plan (event page — Firefox MV3 n'exécute pas de service worker,
// le manifest déclare background.scripts ; mêmes responsabilités, même cycle de vie
// non persistant). Le namespace chrome.* est conservé : Firefox le fournit et, en MV3,
// ses API renvoient des promesses comme browser.* — le code Chrome marche tel quel.
// Deux responsabilités :
//
// 1. Orchestrer le login (la popup se ferme dès qu'un onglet s'ouvre, le flow doit vivre ici) :
//    silencieux d'abord (cookie de session existant → échange direct cookie → JWT), sinon
//    pre-login → provider OAuth → security.oauth getcode → onglet de login → au retour sur
//    le backend, échange cookie → JWT, validation par une query, stockage, fermeture de l'onglet.
//    Backends derrière un proxy authentifiant (OIDC silencieux, en-tête OIDC_CLAIM_upn injecté) :
//    le pre-login est inaccessible avant authentification → repli sur une navigation directe
//    vers le backend (le proxy fait l'OIDC et pose son cookie), puis même échange cookie → JWT.
//
// 2. Renouvellement proactif des tokens (pattern refresh.js du sample) : une alarme horaire
//    renouvelle en Bearer tout token qui expire dans moins de 24 h — le login navigateur
//    ne sert qu'au bootstrap ou après expiration.
import {
  clearAuth,
  decodeJwt,
  ensureHostPermission,
  exchangeCookieForTokens,
  fetchLoginUrl,
  fetchPreLogin,
  fetchQuery,
  getState,
  getValidAuth,
  patchEnv,
  refreshToken,
  resolveQueryName,
  setActiveEnv,
  storeAuth,
  validateToken,
} from "./sinequa.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_BELOW_MS = 24 * 60 * 60 * 1000; // renouvelle si expiration < 24 h

/* ─── Messages de la popup ─── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = { silent: trySilentLogin, login: interactiveLogin, logout };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  resolveEnv(msg.env)
    .then((env) => handler(env))
    .then((auth) => sendResponse({ ok: true, auth }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // réponse asynchrone
});

async function resolveEnv(name) {
  const { envs, active } = await getState();
  const env = envs[name ?? active];
  if (!env) throw new Error(`Environnement inconnu : ${name}`);
  return env;
}

async function logout(env) {
  await clearAuth(env.name);
  await updateBadge();
  return null;
}

/** Échange cookie → JWT sans interaction (suppose une session déjà ouverte sur le backend). */
async function trySilentLogin(env) {
  const existing = await getValidAuth(env.name);
  if (existing) return existing;
  const token = await firstValidToken(env, await exchangeCookieForTokens(env));
  const auth = await storeAuth(env.name, token);
  await updateBadge();
  return auth;
}

async function interactiveLogin(env) {
  // une session traîne peut-être déjà — pas d'onglet inutile
  try {
    return await trySilentLogin(env);
  } catch {
    /* pas de session : flow interactif */
  }

  const loginUrl = await discoverLoginUrl(env);
  const tab = await chrome.tabs.create({ url: loginUrl });

  // À chaque navigation aboutie de cet onglet sur le backend, on tente l'échange :
  // le cookie n'est posé qu'en fin de flow OAuth, les tentatives intermédiaires échouent sans bruit.
  const token = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => settle(reject, new Error("Login expiré (5 min) — onglet laissé ouvert")), LOGIN_TIMEOUT_MS);

    async function onUpdated(tabId, changeInfo, updatedTab) {
      if (tabId !== tab.id || changeInfo.status !== "complete") return;
      if (!updatedTab.url?.startsWith(env.backendUrl)) return; // url visible uniquement pour nos host permissions
      try {
        const valid = await firstValidToken(env, await exchangeCookieForTokens(env));
        chrome.tabs.remove(tabId).catch(() => {});
        settle(resolve, valid);
      } catch {
        /* cookie pas encore posé (étape intermédiaire) : on attend la suite */
      }
    }
    function onRemoved(tabId) {
      if (tabId === tab.id) settle(reject, new Error("Onglet de login fermé avant la fin de l'authentification"));
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });

  const auth = await storeAuth(env.name, token);
  await updateBadge();
  return auth;
}

/**
 * URL à ouvrir pour le login interactif. Serveur Sinequa classique : pre-login →
 * provider OAuth → security.oauth getcode. Si cette découverte échoue (typiquement un
 * backend derrière un proxy authentifiant, dont les API ne répondent pas avant
 * authentification), naviguer vers le backend lui-même suffit : le proxy déroule
 * l'OIDC et pose son cookie de session.
 */
async function discoverLoginUrl(env) {
  try {
    const { autoOAuthProvider } = await fetchPreLogin(env);
    if (!autoOAuthProvider) throw new Error("Aucun provider OAuth découvert via pre-login");
    return await fetchLoginUrl(env, autoOAuthProvider, `${env.backendUrl}/`);
  } catch {
    return `${env.backendUrl}/`;
  }
}

/**
 * Valide les candidats dans l'ordre (une query chacun), renvoie le premier qui passe.
 * Si aucun ne passe en Bearer seul, réessaie en portant aussi les cookies : derrière
 * un proxy authentifiant, les requêtes sans le cookie du proxy sont redirigées vers
 * l'IdP. Un succès dans ce mode est persisté (env.proxyAuth) pour les requêtes suivantes.
 */
async function firstValidToken(env, candidates) {
  for (const candidate of candidates) {
    try {
      return await validateToken(env, candidate);
    } catch {
      /* candidat suivant */
    }
  }
  if (!env.proxyAuth) {
    const proxyEnv = { ...env, proxyAuth: true };
    for (const candidate of candidates) {
      try {
        const token = await validateToken(proxyEnv, candidate);
        await patchEnv(env.name, { proxyAuth: true });
        return token;
      } catch {
        /* candidat suivant */
      }
    }
  }
  throw new Error("Aucun token candidat ne passe la requête de validation");
}

/* ─── Palette (raccourci clavier → overlay injecté dans la page courante) ─── */
// Le raccourci accorde activeTab : l'injection scripting ne demande aucune host
// permission large. Sur les pages non injectables (about:, addons.mozilla.org…), repli
// sur la popup d'action.

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-palette") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "palette-toggle" });
  } catch {
    chrome.action.openPopup().catch(() => {});
  }
});

// Messages du content script — les recherches passent par ici : token et host
// permissions vivent dans l'extension, pas dans la page.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "palette-open") {
    chrome.tabs.create({ url: msg.url, active: !msg.background });
    return false;
  }
  if (msg?.type === "palette-state") {
    getState()
      .then(async ({ envs, active }) => sendResponse({ env: active, envs: Object.keys(envs), connected: Boolean(await getValidAuth(active)) }))
      .catch(() => sendResponse(null));
    return true;
  }
  if (msg?.type === "palette-set-env") {
    (async () => {
      await setActiveEnv(msg.env);
      const env = await resolveEnv(msg.env);
      let connected = Boolean(await getValidAuth(env.name));
      if (!connected && (await ensureHostPermission(env))) {
        // session peut-être déjà ouverte sur ce backend → échange silencieux (comme la popup)
        connected = Boolean(await trySilentLogin(env).catch(() => null));
      }
      sendResponse({ ok: true, env: env.name, connected });
    })().catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (msg?.type === "palette-search") {
    paletteSearch(msg.text)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  return false;
});

async function paletteSearch(text) {
  const { envs, active } = await getState();
  const env = envs[active];
  const auth = env && (await getValidAuth(active));
  if (!auth) return { ok: false, notConnected: true };
  try {
    // nom résolu ici (et non dans fetchQuery) pour le renvoyer à l'UI : les
    // paramètres réellement interrogés sont affichés dans le pied de la palette
    const name = await resolveQueryName(env, auth.token);
    const { result, refreshedToken } = await fetchQuery(env, auth.token, { text, name, pageSize: 8 });
    if (refreshedToken) await storeAuth(active, refreshedToken);
    const records = (result.records ?? []).map((r) => ({
      title: r.title || r.id,
      url: r.url1 || null,
      extract: Array.isArray(r.relevantExtracts) ? r.relevantExtracts.join(" … ") : (r.relevantExtracts ?? ""),
      path: r.treepath?.[0] ?? "",
    }));
    return {
      ok: true,
      total: result.totalRowCount ?? records.length,
      records,
      used: { env: active, backend: env.backendUrl, app: env.app, query: name },
    };
  } catch (e) {
    if (String(e).includes("HTTP 401")) {
      await clearAuth(active); // token révoqué côté serveur
      await updateBadge();
      return { ok: false, notConnected: true };
    }
    throw e;
  }
}

/* ─── Renouvellement proactif ─── */

chrome.runtime.onInstalled.addListener(scheduleRefresh);
chrome.runtime.onStartup.addListener(scheduleRefresh);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh") refreshAll();
});

function scheduleRefresh() {
  chrome.alarms.create("refresh", { delayInMinutes: 1, periodInMinutes: 60 });
}

async function refreshAll() {
  const { envs, auths } = await getState();
  for (const [name, auth] of Object.entries(auths)) {
    const env = envs[name];
    const expMs = (auth?.claims?.exp ?? 0) * 1000;
    if (!env || !auth?.token) continue;
    if (expMs < Date.now()) {
      await clearAuth(name); // expiré : inutilisable, le login navigateur sera nécessaire
      continue;
    }
    if (expMs - Date.now() > REFRESH_BELOW_MS) continue; // encore large, on ne touche à rien
    try {
      const fresh = await refreshToken(env, auth.token);
      await storeAuth(name, fresh);
      const until = decodeJwt(fresh)?.exp;
      console.log(`[refresh] ${name} : token renouvelé${until ? ` jusqu'au ${new Date(until * 1000).toLocaleString()}` : ""}`);
    } catch (e) {
      console.warn(`[refresh] ${name} : renouvellement impossible (${e.message}) — login navigateur requis à l'expiration`);
    }
  }
  await updateBadge();
}

/* ─── Omnibox (mot-clé "sq" dans la barre d'adresse) ─── */
// Suggestions en direct sur l'environnement actif ; sélectionner une suggestion ouvre le
// document, Entrée sur du texte brut ouvre la popup pré-remplie (pendingSearch).

const OMNIBOX_RESULTS = 6;
const OMNIBOX_DEBOUNCE_MS = 250;
let omniboxSeq = 0; // ignore les réponses périmées (frappe rapide)
let omniboxTimer = null;

chrome.omnibox.onInputStarted.addListener(async () => {
  const { active } = await getState();
  const connected = Boolean(await getValidAuth(active));
  // texte brut : Firefox n'interprète ni le %s ni le balisage XML (<match>/<dim>) de Chrome
  chrome.omnibox.setDefaultSuggestion({
    description: connected
      ? `Rechercher sur ${active}`
      : "Non connecté — Entrée pour ouvrir la popup et se connecter",
  });
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  clearTimeout(omniboxTimer);
  if (!text.trim()) return;
  omniboxTimer = setTimeout(async () => {
    const seq = ++omniboxSeq;
    const { envs, active } = await getState();
    const env = envs[active];
    const auth = await getValidAuth(active);
    if (!env || !auth) return;
    try {
      const { result, refreshedToken } = await fetchQuery(env, auth.token, { text, pageSize: OMNIBOX_RESULTS });
      if (refreshedToken) await storeAuth(active, refreshedToken);
      if (seq !== omniboxSeq) return; // une frappe plus récente est partie depuis
      const records = (result.records ?? []).filter((r) => r.url1);
      suggest(
        records.map((r) => ({
          content: r.url1,
          // texte brut : Firefox affiche la description telle quelle (pas de <match>/<dim>)
          description: `${r.title || r.url1} — ${truncate(r.treepath?.[0] || r.url1, 60)}`,
        })),
      );
    } catch {
      /* requête en échec (réseau, 401…) : pas de suggestions */
    }
  }, OMNIBOX_DEBOUNCE_MS);
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  clearTimeout(omniboxTimer);
  if (/^https?:\/\//.test(text)) {
    // une suggestion a été choisie : son content est l'URL du document
    openUrl(text, disposition);
    return;
  }
  // texte brut : on rejoue la recherche dans la popup (pré-remplie via pendingSearch)
  await chrome.storage.local.set({ pendingSearch: text });
  try {
    await chrome.action.openPopup();
  } catch {
    // openPopup indisponible (Firefox l'exige dans un geste utilisateur — l'omnibox compte,
    // mais selon version/contexte il peut refuser) : repli — premier résultat direct
    const { envs, active } = await getState();
    const auth = await getValidAuth(active);
    if (!auth) return;
    try {
      const { result } = await fetchQuery(envs[active], auth.token, { text, pageSize: 1 });
      const url = result.records?.[0]?.url1;
      if (url) openUrl(url, disposition);
    } catch {
      /* tant pis : la recherche reste en attente dans la popup */
    }
  }
});

function openUrl(url, disposition) {
  if (disposition === "currentTab") chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: disposition === "newForegroundTab" });
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ─── Badge (reflète l'environnement actif) ─── */

async function updateBadge() {
  const { active } = await getState();
  const connected = Boolean(await getValidAuth(active));
  await chrome.action.setBadgeText({ text: connected ? "✓" : "" });
  if (connected) await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
}

// changement d'environnement actif (depuis la popup) → badge à jour
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.active || changes.auths)) updateBadge();
});
