// Page d'options — CRUD des environnements (équivalent des .env.<nom> du CLI).
// L'environnement actif se choisit dans la popup ; ici on gère les définitions.
import { clearAuth, deleteEnv, ensureHostPermission, getState, saveEnv } from "./sinequa.js";

const tbody = document.querySelector("#env-table tbody");
const form = document.getElementById("env-form");
const formTitle = document.getElementById("form-title");
const cancelBtn = document.getElementById("cancel-btn");
const message = document.getElementById("message");

let editing = null; // nom de l'environnement en cours d'édition

render();

async function render() {
  const { envs, active, auths } = await getState();
  tbody.replaceChildren(
    ...Object.values(envs).map((env) => {
      const tr = document.createElement("tr");
      tr.append(
        cell(env.name + (env.name === active ? " ●" : ""), env.name === active ? "actif" : ""),
        cell(env.backendUrl),
        cell(env.app),
        cell(env.queryName ?? (env.discoveredQueryName ? `${env.discoveredQueryName} (auto)` : "auto")),
        cell(tokenStatus(auths[env.name])),
      );
      const actions = document.createElement("td");
      actions.append(
        smallBtn("Modifier", () => startEdit(env)),
        smallBtn("Supprimer", () => remove(env)),
      );
      tr.append(actions);
      return tr;
    }),
  );
}

function tokenStatus(auth) {
  if (!auth?.token) return "—";
  const expMs = (auth.claims?.exp ?? 0) * 1000;
  if (!expMs) return "présent";
  return expMs < Date.now() ? "expiré" : `valide jusqu'au ${new Date(expMs).toLocaleString()}`;
}

function cell(text, title = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (title) td.title = title;
  return td;
}

function smallBtn(label, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = onclick;
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
  }

  await saveEnv(env);
  showMessage(`Environnement « ${env.name} » enregistré.`);
  resetForm();
  render();
});

async function remove(env) {
  const { envs } = await getState();
  if (Object.keys(envs).length === 1) {
    showMessage("Impossible de supprimer le dernier environnement.", true);
    return;
  }
  if (!confirm(`Supprimer l'environnement « ${env.name} » (et son token) ?`)) return;
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
