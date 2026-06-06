// Palette de recherche Sinequa — overlay « Spotlight » injecté à la demande par le
// service worker (raccourci clavier). Tout vit dans un Shadow DOM : aucune fuite de
// style entre la page et la palette. Les requêtes passent par le service worker
// (token + host permissions y vivent) ; ici : UI, clavier, états.
//
// Comportement : panneau centré à l'écran tant que la recherche est vide ; dès que
// des résultats arrivent, il remonte vers le haut pour laisser la liste se déployer.
// Le badge d'environnement est un sélecteur : en changer bascule l'actif (partagé avec
// popup/omnibox) et rejoue la recherche en cours sur le nouveau backend.
// Clavier : ↑/↓ (ou Tab) sélection, ↵ ouvrir, Ctrl+↵ ouvrir en arrière-plan, Échap fermer.
(() => {
  if (window.__sinequaPalette) return; // déjà injectée : le listener existant gère le toggle
  window.__sinequaPalette = true;

  const HOST_ID = "sinequa-palette-host";
  // un rechargement de l'extension crée un nouveau monde isolé : l'instance précédente
  // est orpheline (chrome.runtime mort) mais son DOM persiste — on l'évacue
  document.getElementById(HOST_ID)?.remove();

  const DEBOUNCE_MS = 220;
  const MIN_CHARS = 2;
  const RECENTER_DELAY_MS = 450; // délai avant repli/recentrage quand la recherche se vide

  const SEARCH_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.6 10.6 3.2 3.2"/></svg>`;
  const DOC_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/></svg>`;

  // thème : auto (système) → clair → sombre, préférence partagée avec le popup (storage)
  const THEME_ICONS = {
    auto: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M8 2.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor" stroke="none"/></svg>`,
    light: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"/></svg>`,
    dark: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 9.7A5.6 5.6 0 1 1 6.3 2.6a4.6 4.6 0 0 0 7.1 7.1z"/></svg>`,
  };
  const THEME_LABELS = { auto: "auto (système)", light: "clair", dark: "sombre" };
  const THEME_CYCLE = { auto: "light", light: "dark", dark: "auto" };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .overlay {
      --bg: #ffffff; --fg: #1f2328; --muted: #636c76; --faint: #8b949e;
      --border: rgba(27, 31, 36, 0.12); --hover: #f6f8fa;
      --accent: #0969da; --sel: #eef4fc; --kbd-bg: #f6f8fa;
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(15, 18, 25, 0.4);
      backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
      opacity: 0; transition: opacity 0.16s ease;
      font: 14px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    /* thème sombre piloté par classe : préférence utilisateur (auto/clair/sombre) */
    .overlay.dark {
      --bg: #1c2128; --fg: #e6edf3; --muted: #9198a1; --faint: #768390;
      --border: rgba(240, 246, 252, 0.12); --hover: #262c36;
      --accent: #539bf5; --sel: #1c2d45; --kbd-bg: #262c36;
      background: rgba(8, 10, 14, 0.55);
    }
    .overlay.open { opacity: 1; }

    .panel {
      position: absolute; left: 50%; top: 50%;
      transform: translate(-50%, -50%) scale(0.97);
      width: min(660px, calc(100vw - 40px));
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 16px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35), 0 4px 16px rgba(0, 0, 0, 0.18);
      overflow: hidden;
      /* la transition active est celle de l'état d'arrivée : descente (recentrage) lente et feutrée… */
      transition: top 0.55s cubic-bezier(0.3, 0.4, 0.2, 1), transform 0.55s cubic-bezier(0.3, 0.4, 0.2, 1);
    }
    .overlay.open .panel { transform: translate(-50%, -50%) scale(1); }
    /* résultats affichés : la boîte remonte pour laisser la liste se déployer (…montée plus vive) */
    .overlay.open.raised .panel {
      top: max(64px, 9vh); transform: translate(-50%, 0) scale(1);
      transition: top 0.3s cubic-bezier(0.2, 0.8, 0.25, 1), transform 0.3s cubic-bezier(0.2, 0.8, 0.25, 1);
    }

    .search { display: flex; align-items: center; gap: 12px; padding: 15px 18px; }
    .search .icon { width: 19px; height: 19px; color: var(--faint); flex: none; }
    .search input {
      flex: 1; min-width: 0;
      font-family: inherit; font-size: 17px; line-height: 1.4;
      background: none; border: none; outline: none; color: var(--fg);
      caret-color: var(--accent);
    }
    .search input::placeholder { color: var(--faint); }
    /* sélecteur d'environnement déguisé en badge — chevron seulement s'il y a un choix */
    .badge {
      flex: none; font: inherit; font-size: 11px; font-weight: 500; letter-spacing: 0.2px;
      padding: 3px 9px; border-radius: 99px;
      border: 1px solid var(--border); color: var(--muted); background: var(--kbd-bg);
      appearance: none; -webkit-appearance: none; outline: none;
      max-width: 150px; text-overflow: ellipsis; white-space: nowrap;
    }
    .badge.multi {
      cursor: pointer; padding-right: 21px;
      background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="%238b949e" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      background-repeat: no-repeat; background-position: right 7px center; background-size: 10px;
    }
    .badge.multi:hover { color: var(--fg); border-color: var(--accent); }
    .badge option { background: var(--bg); color: var(--fg); }
    .spinner {
      flex: none; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid var(--border); border-top-color: var(--accent);
      animation: spin 0.7s linear infinite; visibility: hidden;
    }
    .spinner.on { visibility: visible; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .theme {
      flex: none; display: inline-flex; padding: 5px;
      border: none; border-radius: 7px; background: none;
      color: var(--faint); cursor: pointer;
    }
    .theme:hover { background: var(--hover); color: var(--fg); }
    .theme svg { width: 16px; height: 16px; }

    .body {
      max-height: 0; overflow-y: auto; overscroll-behavior: contain;
      border-top: 0 solid var(--border);
      transition: max-height 0.55s cubic-bezier(0.3, 0.4, 0.2, 1); /* repli synchronisé avec la descente */
      scrollbar-width: thin;
    }
    .overlay.raised .body {
      max-height: min(62vh, 460px); border-top-width: 1px;
      transition: max-height 0.3s cubic-bezier(0.2, 0.8, 0.25, 1); /* déploiement synchronisé avec la montée */
    }
    .body.note { max-height: 200px; border-top-width: 1px; }

    .results { list-style: none; padding: 6px 0; }
    .item {
      display: flex; gap: 12px; align-items: flex-start;
      padding: 9px 18px; cursor: pointer;
      border-left: 2px solid transparent;
    }
    .item .doc { width: 16px; height: 16px; margin-top: 2px; color: var(--faint); flex: none; }
    .item.sel { background: var(--sel); border-left-color: var(--accent); }
    .item.sel .doc { color: var(--accent); }
    .item .txt { min-width: 0; flex: 1; }
    .item .t {
      font-weight: 600; font-size: 13.5px; color: var(--fg);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .item.sel .t { color: var(--accent); }
    .item .x {
      margin-top: 1px; font-size: 12px; color: var(--muted);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .item .p {
      margin-top: 2px; font-size: 11px; color: var(--faint);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .item .ret { flex: none; align-self: center; font-size: 11px; color: var(--faint); visibility: hidden; }
    .item.sel .ret { visibility: visible; }

    .state { padding: 22px 18px; text-align: center; color: var(--muted); font-size: 13px; }
    .state .err { color: #d1242f; word-break: break-word; }
    @media (prefers-color-scheme: dark) { .state .err { color: #f47067; } }
    .state button {
      margin-top: 10px; font-family: inherit; font-size: 13px; font-weight: 600;
      padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
      background: var(--accent); color: #fff;
    }
    .state button:hover { filter: brightness(1.1); }

    .footer {
      display: flex; align-items: center; gap: 14px;
      padding: 8px 16px; border-top: 1px solid var(--border);
      font-size: 11.5px; color: var(--muted); background: var(--kbd-bg);
    }
    .footer .status { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
    .dot.ok { background: #2da44e; }
    .dot.err { background: #d1242f; }
    .hints { display: flex; gap: 12px; white-space: nowrap; }
    kbd {
      font-family: inherit; font-size: 10.5px; font-weight: 600; line-height: 1;
      padding: 2px 5px; border-radius: 4px;
      border: 1px solid var(--border); border-bottom-width: 2px;
      background: var(--bg); color: var(--muted);
    }
  `;

  let refs = null; // construit paresseusement au premier affichage
  let isOpen = false;
  let selected = -1;
  let records = [];
  let seq = 0; // ignore les réponses périmées (frappe rapide)
  let timer = null;
  let lastFocus = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "palette-toggle") (isOpen ? close : show)();
  });

  /* ─── Thème ─── */

  let themePref = "auto";
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  darkQuery.addEventListener("change", () => {
    if (themePref === "auto") applyTheme(); // suit le système en direct
  });
  try {
    // préférence changée depuis le popup (ou un autre onglet) → synchro immédiate
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.theme) {
        themePref = normalizeTheme(changes.theme.newValue);
        applyTheme();
      }
    });
  } catch {
    /* contexte mort : l'instance sera détruite au prochain échange */
  }

  function normalizeTheme(value) {
    return value in THEME_CYCLE ? value : "auto";
  }

  async function loadTheme() {
    applyTheme(); // valeur courante tout de suite (pas de flash en attendant le storage)
    try {
      const { theme } = await chrome.storage.local.get("theme");
      themePref = normalizeTheme(theme);
    } catch {
      return; /* contexte mort : on garde la valeur courante */
    }
    applyTheme();
  }

  function applyTheme() {
    if (!refs) return;
    const dark = themePref === "dark" || (themePref === "auto" && darkQuery.matches);
    refs.overlay.classList.toggle("dark", dark);
    refs.themeBtn.innerHTML = THEME_ICONS[themePref];
    refs.themeBtn.title = `Thème : ${THEME_LABELS[themePref]} — cliquer pour changer`;
  }

  /* ─── Robustesse au rechargement de l'extension ───
     Quand l'extension est rechargée/mise à jour, cette instance devient orpheline :
     chrome.runtime.sendMessage lève alors une exception SYNCHRONE (« Extension context
     invalidated ») qu'un .catch() ne peut pas rattraper. Tout passe par send(). */

  function contextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /** sendMessage sûr : ne lève jamais. Contexte mort → message à l'utilisateur, renvoie null. */
  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      if (!contextAlive() && isOpen) {
        setSpinner(false);
        renderNote("L'extension a été rechargée — fermez (Échap) puis rouvrez la palette avec le raccourci.", { error: true });
      }
      return null;
    }
  }

  /** Retire cette instance de la page — la prochaine injection repart de zéro. */
  function destroy() {
    isOpen = false;
    clearTimeout(timer);
    refs?.host.remove();
    refs = null;
    window.__sinequaPalette = false;
  }

  function build() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.display = "none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="overlay" part="overlay">
        <div class="panel" role="dialog" aria-label="Recherche Sinequa">
          <div class="search">
            <span class="icon">${SEARCH_ICON}</span>
            <input type="text" placeholder="Rechercher dans la documentation…" autocomplete="off" spellcheck="false" />
            <span class="spinner"></span>
            <select class="badge" title="Environnement" hidden></select>
            <button class="theme" type="button"></button>
          </div>
          <div class="body">
            <ul class="results" role="listbox"></ul>
            <div class="state" hidden></div>
          </div>
          <div class="footer">
            <span class="status"><span class="dot"></span><span class="status-text">…</span></span>
            <span class="hints">
              <span><kbd>↑</kbd> <kbd>↓</kbd> naviguer</span>
              <span><kbd>↵</kbd> ouvrir</span>
              <span><kbd>Échap</kbd> fermer</span>
            </span>
          </div>
        </div>
      </div>`;
    (document.body ?? document.documentElement).append(host);

    const $ = (sel) => root.querySelector(sel);
    refs = {
      host,
      overlay: $(".overlay"),
      panel: $(".panel"),
      input: $("input"),
      spinner: $(".spinner"),
      badge: $(".badge"),
      themeBtn: $(".theme"),
      body: $(".body"),
      list: $(".results"),
      state: $(".state"),
      dot: $(".dot"),
      statusText: $(".status-text"),
    };

    // La page hôte ne doit jamais voir les frappes destinées à la palette : beaucoup
    // de sites ont des raccourcis globaux (/, s, g…) qui détournent la saisie ou
    // re-focusent leurs propres champs. Les événements clavier s'arrêtent ici.
    for (const type of ["keydown", "keyup", "keypress"]) {
      refs.overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    // Dialog modale : si la page reprend le focus (raccourci global, autofocus…),
    // on le ramène dans l'input pour que la saisie continue sans interruption.
    document.addEventListener("focusin", (e) => {
      if (isOpen && e.target !== refs.host) refs.input.focus();
    });

    refs.overlay.addEventListener("mousedown", (e) => {
      if (e.target === refs.overlay) close(); // clic sur le fond uniquement
    });
    // (sauf le sélecteur d'environnement : lui voler le focus fermerait sa liste native)
    refs.panel.addEventListener("click", (e) => {
      if (e.target !== refs.badge) refs.input.focus();
    });
    refs.badge.addEventListener("change", onEnvChange);
    refs.themeBtn.addEventListener("click", () => {
      themePref = THEME_CYCLE[themePref];
      applyTheme();
      try {
        chrome.storage.local.set({ theme: themePref }); // partagé avec popup/options
      } catch {
        /* contexte mort : préférence appliquée localement seulement */
      }
    });
    refs.input.addEventListener("input", onType);
    refs.input.addEventListener("keydown", onKey);
    refs.list.addEventListener("click", (e) => {
      const item = e.target.closest(".item");
      if (item) openRecord(records[Number(item.dataset.i)], { background: e.ctrlKey || e.metaKey });
    });
    refs.list.addEventListener("mousemove", (e) => {
      const item = e.target.closest(".item");
      if (item) select(Number(item.dataset.i), { scroll: false });
    });
  }

  async function show() {
    if (!refs) build();
    loadTheme(); // applique aussi la valeur par défaut en attendant le storage
    lastFocus = document.activeElement;
    isOpen = true;
    selected = -1;
    records = [];
    refs.input.value = "";
    refs.list.replaceChildren();
    refs.state.hidden = true;
    refs.body.classList.remove("note");
    refs.overlay.classList.remove("raised");
    refs.host.style.display = "";
    requestAnimationFrame(() => refs.overlay.classList.add("open")); // laisse la transition jouer
    refs.input.focus();

    const st = await send({ type: "palette-state" });
    if (!isOpen) return;
    renderEnvs(st?.envs ?? (st?.env ? [st.env] : []), st?.env);
    setStatus(st?.connected);
    if (st && !st.connected) renderLogin();
  }

  function renderEnvs(names, active) {
    refs.badge.replaceChildren(
      ...names.map((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        opt.selected = name === active;
        return opt;
      }),
    );
    refs.badge.hidden = names.length === 0;
    refs.badge.classList.toggle("multi", names.length > 1); // un seul env : simple badge informatif
    refs.badge.title = names.length > 1 ? "Changer d'environnement" : "Environnement";
  }

  /** Bascule l'environnement actif (service worker) puis rejoue la recherche en cours. */
  async function onEnvChange() {
    seq++; // toute réponse en vol devient périmée (elle visait l'ancien environnement)
    clearTimeout(timer);
    setSpinner(true);
    const res = await send({ type: "palette-set-env", env: refs.badge.value });
    if (!isOpen) return;
    setSpinner(false);
    setRecords([]);
    refs.state.hidden = true;
    refs.body.classList.remove("note");
    refs.input.focus();
    if (!res) return; // contexte mort : send() a déjà affiché le message
    if (!res.ok) {
      renderNote(res.error ?? "Changement d'environnement impossible.", { error: true });
      return;
    }
    setStatus(res.connected);
    const text = refs.input.value.trim();
    if (!res.connected) renderLogin();
    else if (text.length >= MIN_CHARS) runSearch(text);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(timer);
    seq++; // toute réponse en vol devient périmée
    refs.overlay.classList.remove("open");
    setTimeout(() => {
      if (isOpen) return;
      if (!contextAlive()) destroy(); // instance orpheline : on libère la place
      else refs.host.style.display = "none";
    }, 180);
    lastFocus?.focus?.();
  }

  function setStatus(connected) {
    refs.dot.className = `dot ${connected ? "ok" : "err"}`;
    refs.statusText.textContent = connected ? "Connecté" : "Non connecté";
  }

  /* ─── Recherche au fil de la frappe ─── */

  function onType() {
    clearTimeout(timer);
    const text = refs.input.value.trim();
    if (text.length < MIN_CHARS) {
      seq++; // toute réponse en vol devient périmée
      setSpinner(false);
      // recentrage différé : si l'utilisateur efface pour retaper aussitôt,
      // la boîte ne bouge pas du tout
      timer = setTimeout(() => {
        setRecords([]);
        refs.state.hidden = true;
        refs.body.classList.remove("note");
      }, RECENTER_DELAY_MS);
      return;
    }
    timer = setTimeout(() => runSearch(text), DEBOUNCE_MS);
  }

  async function runSearch(text) {
    const mySeq = ++seq;
    setSpinner(true);
    const res = await send({ type: "palette-search", text });
    if (mySeq !== seq || !isOpen) return; // frappe plus récente partie depuis
    setSpinner(false);
    if (res === null) {
      // contexte mort : send() a déjà affiché le message ; sinon, worker muet
      if (contextAlive()) renderNote("Le service worker n'a pas répondu — réessayez.", { error: true });
      return;
    }
    if (res?.ok) {
      setStatus(true);
      if (res.used) {
        // transparence : les paramètres réellement interrogés, visibles au pied
        refs.statusText.textContent = `${res.used.env} · ${res.used.app} · ${res.used.query}`;
        refs.statusText.title = res.used.backend;
      }
      setRecords(res.records);
      if (res.records.length === 0) renderNote("Aucun résultat.");
    } else if (res?.notConnected) {
      setStatus(false);
      setRecords([]);
      renderLogin();
    } else {
      setRecords([]);
      renderNote(res?.error ?? "Erreur inconnue", { error: true });
    }
  }

  function setSpinner(on) {
    refs.spinner.classList.toggle("on", on);
  }

  /* ─── Rendu ─── */

  function setRecords(rs) {
    records = rs;
    selected = rs.length ? 0 : -1;
    refs.state.hidden = true;
    refs.body.classList.remove("note");
    refs.overlay.classList.toggle("raised", rs.length > 0); // ← la boîte remonte
    refs.list.replaceChildren(
      ...rs.map((r, i) => {
        const li = document.createElement("li");
        li.className = `item${i === selected ? " sel" : ""}`;
        li.dataset.i = i;
        li.setAttribute("role", "option");

        const doc = document.createElement("span");
        doc.className = "doc";
        doc.innerHTML = DOC_ICON;

        const txt = document.createElement("div");
        txt.className = "txt";
        const t = document.createElement("div");
        t.className = "t";
        t.textContent = r.title;
        txt.append(t);
        if (r.extract) {
          const x = document.createElement("div");
          x.className = "x";
          x.textContent = stripHtml(r.extract); // texte brut : pas d'injection HTML
          txt.append(x);
        }
        if (r.path) {
          const p = document.createElement("div");
          p.className = "p";
          p.textContent = r.path;
          p.title = r.path;
          txt.append(p);
        }

        const ret = document.createElement("span");
        ret.className = "ret";
        ret.textContent = "↵";

        li.append(doc, txt, ret);
        return li;
      }),
    );
    refs.body.scrollTop = 0;
  }

  function renderNote(text, { error = false } = {}) {
    refs.state.replaceChildren();
    const span = document.createElement("span");
    span.className = error ? "err" : "";
    span.textContent = text;
    refs.state.append(span);
    refs.state.hidden = false;
    refs.body.classList.add("note");
    refs.overlay.classList.remove("raised");
  }

  function renderLogin() {
    renderNote("Non connecté à Sinequa.");
    const btn = document.createElement("button");
    btn.textContent = "Se connecter";
    btn.onclick = async () => {
      btn.disabled = true;
      renderNote("Authentification dans un onglet… La palette se mettra à jour au retour.");
      // le service worker mène le flow seul ; la réponse arrive quand le login aboutit
      const res = await send({ type: "login" });
      if (!isOpen) return;
      if (res?.ok) {
        setStatus(true);
        refs.state.hidden = true;
        refs.body.classList.remove("note");
        refs.input.focus();
        if (refs.input.value.trim().length >= MIN_CHARS) runSearch(refs.input.value.trim());
      } else {
        renderNote(res?.error ?? "Échec de l'authentification.", { error: true });
      }
    };
    refs.state.append(document.createElement("br"), btn);
  }

  /* ─── Clavier ─── */

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      openRecord(records[selected], { background: e.ctrlKey || e.metaKey });
    }
  }

  function move(delta) {
    if (!records.length) return;
    select((selected + delta + records.length) % records.length);
  }

  function select(i, { scroll = true } = {}) {
    if (i === selected || !records[i]) return;
    selected = i;
    for (const li of refs.list.children) li.classList.toggle("sel", Number(li.dataset.i) === i);
    if (scroll) refs.list.children[i]?.scrollIntoView({ block: "nearest" });
  }

  function openRecord(record, { background = false } = {}) {
    if (!record?.url) return;
    send({ type: "palette-open", url: record.url, background });
    if (!background) close();
  }

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent ?? "";
  }
})();
