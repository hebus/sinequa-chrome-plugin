// Popup — sélecteur d'environnement, état de connexion, recherches.
// Le login interactif est délégué au service worker (la popup se ferme dès qu'un
// onglet s'ouvre) ; les recherches se font ici (la popup reste ouverte pendant un fetch).
import { ensureHostPermission, fetchQuery, getState, getValidAuth, setActiveEnv, storeAuth } from "./sinequa.js";

const el = (id) => document.getElementById(id);
const envSelect = el("env-select");
const statusDot = el("status-dot");
const statusText = el("status-text");
const authBtn = el("auth-btn");
const optionsBtn = el("options-btn");
const form = el("search-form");
const input = el("search-input");
const searchBtn = el("search-btn");
const message = el("message");
const meta = el("meta");
const results = el("results");

let env = null;
let auth = null;

optionsBtn.onclick = () => chrome.runtime.openOptionsPage();
envSelect.onchange = async () => {
  await setActiveEnv(envSelect.value);
  results.replaceChildren();
  meta.hidden = true;
  showMessage("");
  await init();
};

init();

async function init() {
  const { envs, active } = await getState();
  envSelect.replaceChildren(
    ...Object.keys(envs).map((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      opt.selected = name === active;
      return opt;
    }),
  );
  envSelect.hidden = Object.keys(envs).length < 2; // inutile avec un seul environnement
  env = envs[active];

  statusText.textContent = "Vérification…";
  statusDot.className = "dot";
  auth = await getValidAuth(env.name);
  if (!auth && (await ensureHostPermission(env))) {
    // session peut-être déjà ouverte sur le backend → échange silencieux
    const res = await chrome.runtime.sendMessage({ type: "silent", env: env.name }).catch(() => null);
    if (res?.ok) auth = res.auth;
  }
  render();

  // recherche lancée depuis l'omnibox (Entrée sur du texte brut) → rejouée ici
  const { pendingSearch } = await chrome.storage.local.get("pendingSearch");
  if (pendingSearch) {
    await chrome.storage.local.remove("pendingSearch");
    input.value = pendingSearch;
    if (auth) form.requestSubmit();
  }
}

function render() {
  if (auth) {
    statusDot.className = "dot ok";
    statusText.textContent = "Connecté";
    statusText.title = auth.claims?.exp ? `Token valide jusqu'au ${new Date(auth.claims.exp * 1000).toLocaleString()}` : "";
    authBtn.textContent = "Déconnexion";
    authBtn.onclick = logout;
    form.hidden = false;
    input.focus();
  } else {
    statusDot.className = "dot err";
    statusText.textContent = "Non connecté";
    statusText.title = "";
    authBtn.textContent = "Se connecter";
    authBtn.onclick = login;
    form.hidden = true;
  }
  authBtn.hidden = false;
}

async function login() {
  // host permission de l'environnement (les non-défauts passent par optional_host_permissions —
  // le clic sur ce bouton fournit le geste utilisateur exigé par permissions.request)
  if (!(await ensureHostPermission(env, { request: true }))) {
    showMessage(`Permission refusée pour ${env.backendUrl} — impossible de s'y connecter.`, true);
    return;
  }
  authBtn.disabled = true;
  showMessage("Authentification dans l'onglet ouvert… (la popup peut se fermer, rouvrez-la ensuite)");
  // Si un onglet de login s'ouvre, la popup se ferme et cette réponse n'arrivera jamais —
  // le service worker termine le flow seul ; au cas silencieux, la réponse arrive bien.
  const res = await chrome.runtime.sendMessage({ type: "login", env: env.name }).catch(() => null);
  authBtn.disabled = false;
  if (res?.ok) {
    auth = res.auth;
    showMessage("");
    render();
  } else if (res) {
    showMessage(res.error, true);
  }
}

async function logout() {
  await chrome.runtime.sendMessage({ type: "logout", env: env.name });
  auth = null;
  results.replaceChildren();
  meta.hidden = true;
  showMessage("");
  render();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !auth) return;

  searchBtn.disabled = true;
  showMessage("Recherche…");
  meta.hidden = true;
  results.replaceChildren();
  try {
    const { result, refreshedToken } = await fetchQuery(env, auth.token, { text });
    if (refreshedToken) auth = await storeAuth(env.name, refreshedToken); // renouvellement transparent
    showMessage("");
    renderResults(result);
  } catch (err) {
    if (String(err).includes("HTTP 401")) {
      // token révoqué/expiré côté serveur → retour à l'état déconnecté
      await chrome.runtime.sendMessage({ type: "logout", env: env.name });
      auth = null;
      render();
      showMessage("Session expirée — reconnectez-vous.", true);
    } else {
      showMessage(String(err.message ?? err), true);
    }
  } finally {
    searchBtn.disabled = false;
  }
});

function renderResults(result) {
  const records = result.records ?? [];
  meta.textContent = `${result.totalRowCount ?? records.length} résultat(s)`;
  meta.hidden = false;
  results.replaceChildren(
    ...records.map((r) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = r.url1 || "#";
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = r.title || r.id;
      li.append(a);
      const extractHtml = Array.isArray(r.relevantExtracts) ? r.relevantExtracts.join(" … ") : r.relevantExtracts;
      if (extractHtml) {
        const extract = document.createElement("div");
        extract.className = "extract";
        extract.textContent = stripHtml(extractHtml); // texte brut : pas d'injection HTML
        li.append(extract);
      }
      if (Array.isArray(r.treepath) && r.treepath[0]) {
        const path = document.createElement("div");
        path.className = "path";
        path.textContent = r.treepath[0];
        path.title = r.treepath[0];
        li.append(path);
      }
      return li;
    }),
  );
  if (records.length === 0) showMessage("Aucun résultat.");
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent ?? "";
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? "error" : "";
  message.hidden = !text;
}
