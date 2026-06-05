// Client Sinequa minimal — reproduit les payloads de @sinequa/atomic (cf. nodejs-atomic-sample).
// Grâce aux host permissions (statiques ou accordées à la demande), les fetch de l'extension
// ne sont pas soumis au CORS et peuvent porter les cookies du backend (credentials: "include").
//
// Multi-environnements : chaque environnement { name, backendUrl, app, queryName? } est stocké
// dans chrome.storage.local (comme les .env.<nom> du sample), avec un token par environnement.

export const DEFAULT_ENV = {
  name: "docsearch",
  backendUrl: "https://docsearch.sinequa.com",
  app: "tech-doc-ns",
  queryName: "tech-doc-pf-ns-en_query",
};

export const LOCALE = "en";

// noms de champ candidats pour le JWT dans la réponse webtoken, par ordre de priorité
// (même liste que login.js du sample)
const TOKEN_PARAMS = ["webToken", "webtoken", "token", "jwt", "access_token", "id_token", "csrfToken", "code"];

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "Sinequa-Force-Camel-Case": "true",
};

async function asJson(res) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${res.url} — ${detail}`);
  }
  return body;
}

/* ─── API Sinequa (paramétrée par environnement) ─── */

/** GET api/v1/app?preLogin=true — découvre le provider OAuth (autoOAuthProvider). */
export async function fetchPreLogin(env) {
  const params = new URLSearchParams({ app: env.app, preLogin: "true" });
  const res = await fetch(`${env.backendUrl}/api/v1/app?${params}`, { headers: JSON_HEADERS });
  return asJson(res);
}

/** POST security.oauth getcode — URL de la page de login du provider (cookie de session en retour). */
export async function fetchLoginUrl(env, provider, originalUrl) {
  const res = await fetch(`${env.backendUrl}/api/v1/security.oauth`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      action: "getcode",
      provider,
      tokenInCookie: true, // le JWT de session va en cookie : l'extension fera l'échange cookie → JWT
      originalUrl,
      app: env.app,
    }),
  });
  const { redirectUrl } = await asJson(res);
  if (!redirectUrl) throw new Error("security.oauth n'a pas renvoyé de redirectUrl");
  return redirectUrl;
}

/**
 * Échange cookie de session → JWT : challenge (csrfToken) puis security.webtoken
 * { tokenInCookie: false }. Renvoie la liste des candidats (strings), priorisée.
 * Échoue si aucun cookie de session (challenge sans csrfToken).
 */
export async function exchangeCookieForTokens(env) {
  const challenge = await fetch(`${env.backendUrl}/api/v1/challenge?action=getCsrfToken&suppressErrors=true`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  }).then(asJson);
  if (!challenge?.csrfToken) throw new Error("Pas de session sur le backend (challenge sans csrfToken)");

  const webtoken = await fetch(`${env.backendUrl}/api/v1/security.webtoken`, {
    method: "POST",
    credentials: "include",
    headers: { ...JSON_HEADERS, "Sinequa-csrf-token": challenge.csrfToken },
    body: JSON.stringify({ action: "get", tokenInCookie: false }),
  }).then(asJson);

  const fields = Object.fromEntries(Object.entries(webtoken).filter(([, v]) => typeof v === "string" && v.length > 0));
  const prioritized = TOKEN_PARAMS.map((k) => fields[k]).filter(Boolean);
  const rest = Object.values(fields).filter((v) => !prioritized.includes(v));
  const candidates = [...new Set([...prioritized, ...rest])];
  if (candidates.length === 0) throw new Error(`Aucun token dans la réponse webtoken : ${JSON.stringify(webtoken).slice(0, 300)}`);
  return candidates;
}

/**
 * Renouvelle le JWT sans navigateur (pattern refresh.js du sample) :
 * security.webtoken accepte l'auth Bearer → un token encore valide en obtient un neuf.
 */
export async function refreshToken(env, token) {
  const res = await fetch(`${env.backendUrl}/api/v1/security.webtoken`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "get", tokenInCookie: false }),
  });
  const body = await asJson(res);
  const fresh = Object.values(body).find((v) => typeof v === "string" && v.split(".").length === 3);
  if (!fresh) throw new Error(`Réponse webtoken sans JWT : ${JSON.stringify(body).slice(0, 300)}`);
  return fresh;
}

/**
 * Nom de query à utiliser : celui de l'environnement, sinon résolu depuis la config
 * de l'app (fetchApp → defaultQueryName, sinon première entrée de queries, sinon "_query"
 * — même chaîne de secours que login.js du sample). Le nom découvert est persisté.
 */
export async function resolveQueryName(env, token) {
  if (env.queryName) return env.queryName;
  if (env.discoveredQueryName) return env.discoveredQueryName;
  try {
    const params = new URLSearchParams({ app: env.app });
    const app = await fetch(`${env.backendUrl}/api/v1/app?${params}`, {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    }).then(asJson);
    const name = app.defaultQueryName || Object.keys(app.queries ?? {})[0] || "_query";
    await patchEnv(env.name, { discoveredQueryName: name });
    return name;
  } catch {
    return "_query";
  }
}

/**
 * POST api/v1/query — payload exact de la lib atomic :
 * { app, query, locale, noUserOverride, noAutoAuthentication }.
 * Renvoie { result, refreshedToken } — refreshedToken si le serveur a renvoyé
 * un header sinequa-jwt-refresh (token renouvelé à persister).
 */
export async function fetchQuery(env, token, query) {
  const name = query.name ?? (await resolveQueryName(env, token));
  const res = await fetch(`${env.backendUrl}/api/v1/query`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      app: env.app,
      query: { ...query, name },
      locale: LOCALE,
      noUserOverride: true,
      noAutoAuthentication: true,
    }),
  });
  const refreshedToken = res.headers.get("sinequa-jwt-refresh") || null;
  const result = await asJson(res);
  return { result, refreshedToken };
}

/** Valide un token candidat par une requête first page (comme login.js). */
export async function validateToken(env, token) {
  await fetchQuery(env, token, { isFirstPage: true });
  return token;
}

/** Décode les claims d'un JWT (sans vérification de signature — affichage uniquement). */
export function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

/* ─── Environnements + tokens (chrome.storage.local) ─── */
// Schéma : { envs: { [name]: env }, active: name, auths: { [name]: { token, claims, savedAt } } }

/** État complet, avec amorçage de l'environnement par défaut et migration du schéma v0.1. */
export async function getState() {
  const data = await chrome.storage.local.get(["envs", "active", "auths", "auth"]);
  let { envs, active, auths } = data;
  let dirty = false;
  if (!envs || Object.keys(envs).length === 0) {
    envs = { [DEFAULT_ENV.name]: { ...DEFAULT_ENV } };
    dirty = true;
  }
  if (!active || !envs[active]) {
    active = Object.keys(envs)[0];
    dirty = true;
  }
  if (!auths) {
    auths = {};
    dirty = true;
  }
  if (data.auth) {
    // migration v0.1 : token unique → token de l'environnement par défaut
    auths[DEFAULT_ENV.name] = data.auth;
    await chrome.storage.local.remove("auth");
    dirty = true;
  }
  if (dirty) await chrome.storage.local.set({ envs, active, auths });
  return { envs, active, auths };
}

export async function getActiveEnv() {
  const { envs, active } = await getState();
  return envs[active];
}

export async function setActiveEnv(name) {
  const { envs } = await getState();
  if (!envs[name]) throw new Error(`Environnement inconnu : ${name}`);
  await chrome.storage.local.set({ active: name });
}

/** Crée ou remplace un environnement. */
export async function saveEnv(env) {
  const { envs } = await getState();
  envs[env.name] = env;
  await chrome.storage.local.set({ envs });
}

/** Met à jour partiellement un environnement (ex. queryName découvert). */
export async function patchEnv(name, patch) {
  const { envs } = await getState();
  if (!envs[name]) return;
  envs[name] = { ...envs[name], ...patch };
  await chrome.storage.local.set({ envs });
}

export async function deleteEnv(name) {
  const { envs, active, auths } = await getState();
  delete envs[name];
  delete auths[name];
  const newActive = active === name ? Object.keys(envs)[0] : active;
  await chrome.storage.local.set({ envs, auths, ...(newActive !== active && { active: newActive }) });
}

/** Le token stocké d'un environnement, ou null s'il est absent/expiré. */
export async function getValidAuth(envName) {
  const { auths } = await getState();
  const auth = auths[envName];
  if (!auth?.token) return null;
  if (auth.claims?.exp && auth.claims.exp * 1000 < Date.now()) return null;
  return auth;
}

export async function storeAuth(envName, token) {
  const { auths } = await getState();
  const auth = { token, claims: decodeJwt(token), savedAt: Date.now() };
  auths[envName] = auth;
  await chrome.storage.local.set({ auths });
  return auth;
}

export async function clearAuth(envName) {
  const { auths } = await getState();
  delete auths[envName];
  await chrome.storage.local.set({ auths });
}

/** Pattern d'origine pour chrome.permissions (ex. "https://docsearch.sinequa.com/*"). */
export function originPattern(env) {
  return `${new URL(env.backendUrl).origin}/*`;
}

/** Vérifie/demande la host permission d'un environnement (request exige un geste utilisateur). */
export async function ensureHostPermission(env, { request = false } = {}) {
  const origins = [originPattern(env)];
  if (await chrome.permissions.contains({ origins })) return true;
  if (!request) return false;
  return chrome.permissions.request({ origins });
}
