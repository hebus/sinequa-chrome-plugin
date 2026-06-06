// Page d'options — CRUD des environnements (équivalent des .env.<nom> du CLI).
// Affichée en dialog native par-dessus chrome://extensions (open_in_tab: false).
// L'environnement actif se choisit dans la popup ; ici on gère les définitions.
import { clearAuth, deleteEnv, ensureHostPermission, getState, saveEnv, setActiveEnv } from "./sinequa.js";

const EDIT_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11.1 2.2 13.8 4.9 5.6 13.1l-3.3.6.6-3.3z"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.2h11M6.2 4.2V2.8h3.6v1.4M3.8 4.2l.7 9.4h7l.7-9.4M6.5 7v4M9.5 7v4"/></svg>`;

const list = document.getElementById("env-list");
const form = document.getElementById("env-form");
const formTitle = document.getElementById("form-title");
const cancelBtn = document.getElementById("cancel-btn");
const message = document.getElementById("message");

let editing = null; // nom de l'environnement en cours d'édition

// thème : suit la préférence partagée (bouton dans le popup et la palette)
applyTheme();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.theme) applyTheme();
});
async function applyTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  document.documentElement.style.colorScheme = theme === "light" || theme === "dark" ? theme : "light dark";
}

render();

async function render() {
  const { envs, active, auths } = await getState();
  list.replaceChildren(
    ...Object.values(envs).map((env) => {
      const li = document.createElement("li");
      li.className = `env-card${env.name === active ? " active" : ""}`;

      const main = document.createElement("div");
      main.className = "env-main";

      const head = document.createElement("div");
      head.className = "env-head";
      const name = document.createElement("span");
      name.className = "env-name";
      name.textContent = env.name;
      head.append(name);
      if (env.name === active) head.append(badge("actif", "accent"));
      head.append(tokenBadge(auths[env.name]));

      const url = document.createElement("div");
      url.className = "env-url";
      url.textContent = env.backendUrl;
      url.title = env.backendUrl;

      const metaText = `app ${env.app} · query ${env.queryName ?? (env.discoveredQueryName ? `${env.discoveredQueryName} (auto)` : "auto")}`;
      const meta = document.createElement("div");
      meta.className = "env-meta";
      meta.textContent = metaText;
      meta.title = metaText;

      main.append(head, url, meta);

      const actions = document.createElement("div");
      actions.className = "env-actions";
      if (env.name !== active) {
        const activate = document.createElement("button");
        activate.type = "button";
        activate.className = "activate-btn";
        activate.textContent = "Activer";
        activate.title = `Faire de « ${env.name} » l'environnement des recherches`;
        activate.onclick = async () => {
          await setActiveEnv(env.name);
          render();
        };
        actions.append(activate);
      }
      actions.append(
        iconBtn(EDIT_ICON, `Modifier « ${env.name} »`, () => startEdit(env)),
        deleteBtn(env),
      );

      li.append(main, actions);
      return li;
    }),
  );
}

function badge(text, kind = "", title = "") {
  const span = document.createElement("span");
  span.className = `badge ${kind}`;
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

function tokenBadge(auth) {
  if (!auth?.token) return badge("aucun token");
  const expMs = (auth.claims?.exp ?? 0) * 1000;
  if (!expMs) return badge("token présent", "ok");
  if (expMs < Date.now()) return badge("token expiré", "err");
  return badge("token valide", "ok", `Valide jusqu'au ${new Date(expMs).toLocaleString()}`);
}

function iconBtn(icon, title, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn";
  b.innerHTML = icon;
  b.title = title;
  b.onclick = onclick;
  return b;
}

/** Suppression en deux temps — confirm() est bloqué dans la dialog embarquée de chrome://extensions. */
function deleteBtn(env) {
  const b = iconBtn(TRASH_ICON, `Supprimer « ${env.name} » (et son token)`, () => {
    if (!b.classList.contains("confirm")) {
      b.classList.add("confirm");
      b.replaceChildren("Supprimer ?");
      setTimeout(() => {
        if (!b.isConnected) return;
        b.classList.remove("confirm");
        b.innerHTML = TRASH_ICON;
      }, 3000);
      return;
    }
    remove(env);
  });
  b.classList.add("danger");
  return b;
}

function startEdit(env) {
  editing = env.name;
  formTitle.textContent = `Modifier « ${env.name} »`;
  form.name.value = env.name;
  form.name.disabled = true; // le nom est la clé (du token aussi) — pas de renommage
  form.backendUrl.value = env.backendUrl;
  form.app.value = env.app;
  form.queryName.value = env.queryName ?? "";
  cancelBtn.hidden = false;
  form.scrollIntoView({ behavior: "smooth" });
}

function resetForm() {
  editing = null;
  form.reset();
  form.name.disabled = false;
  formTitle.textContent = "Ajouter un environnement";
  cancelBtn.hidden = true;
}

cancelBtn.onclick = resetForm;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const env = {
    name: editing ?? form.name.value.trim(),
    backendUrl: form.backendUrl.value.trim().replace(/\/+$/, ""), // sans slash final
    app: form.app.value.trim(),
  };
  const queryName = form.queryName.value.trim();
  if (queryName) env.queryName = queryName;

  const { envs } = await getState();
  if (!editing && envs[env.name]) {
    showMessage(`Un environnement « ${env.name} » existe déjà.`, true);
    return;
  }

  // host permission du backend (le clic Enregistrer fournit le geste utilisateur)
  if (!(await ensureHostPermission(env, { request: true }))) {
    showMessage(`Permission refusée pour ${env.backendUrl} — environnement non enregistré.`, true);
    return;
  }

  // backend ou app modifié → le token stocké ne correspond plus, on l'invalide
  const previous = envs[env.name];
  if (previous && (previous.backendUrl !== env.backendUrl || previous.app !== env.app)) {
    await clearAuth(env.name);
  } else if (previous?.proxyAuth) {
    // mode proxy authentifiant détecté au login : même backend, toujours valable
    env.proxyAuth = true;
  }

  await saveEnv(env);
  // un environnement fraîchement créé devient l'environnement des recherches —
  // sinon la palette continue d'interroger l'ancien actif, à rebours de l'intention
  const created = !editing;
  if (created) await setActiveEnv(env.name);
  showMessage(`Environnement « ${env.name} » enregistré${created ? " et activé" : ""}.`);
  resetForm();
  render();
});

async function remove(env) {
  const { envs } = await getState();
  if (Object.keys(envs).length === 1) {
    showMessage("Impossible de supprimer le dernier environnement.", true);
    return;
  }
  await deleteEnv(env.name);
  showMessage(`Environnement « ${env.name} » supprimé.`);
  if (editing === env.name) resetForm();
  render();
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? "error" : "ok";
  message.hidden = !text;
}
