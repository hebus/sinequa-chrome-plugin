// Palette de recherche Sinequa — overlay « Spotlight » injecté à la demande par le
// service worker (raccourci clavier). Tout vit dans un Shadow DOM : aucune fuite de
// style entre la page et la palette. Les requêtes passent par le service worker
// (token + host permissions y vivent) ; ici : UI, clavier, états.
//
// Comportement : panneau centré à l'écran tant que la recherche est vide ; dès que
// des résultats arrivent, il remonte vers le haut pour laisser la liste se déployer.
// Clavier : ↑/↓ (ou Tab) sélection, ↵ ouvrir, Ctrl+↵ ouvrir en arrière-plan, Échap fermer.
(() => {
  if (window.__sinequaPalette) return; // déjà injectée : le listener existant gère le toggle
  window.__sinequaPalette = true;

  const DEBOUNCE_MS = 220;
  const MIN_CHARS = 2;
  const RECENTER_DELAY_MS = 450; // délai avant repli/recentrage quand la recherche se vide

  const SEARCH_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.6 10.6 3.2 3.2"/></svg>`;
  const DOC_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/></svg>`;

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
    @media (prefers-color-scheme: dark) {
      .overlay {
        --bg: #1c2128; --fg: #e6edf3; --muted: #9198a1; --faint: #768390;
        --border: rgba(240, 246, 252, 0.12); --hover: #262c36;
        --accent: #539bf5; --sel: #1c2d45; --kbd-bg: #262c36;
        background: rgba(8, 10, 14, 0.55);
      }
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
    .badge {
      flex: none; font-size: 11px; font-weight: 500; letter-spacing: 0.2px;
      padding: 3px 9px; border-radius: 99px;
      border: 1px solid var(--border); color: var(--muted); background: var(--kbd-bg);
    }
    .spinner {
      flex: none; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid var(--border); border-top-color: var(--accent);
      animation: spin 0.7s linear infinite; visibility: hidden;
    }
    .spinner.on { visibility: visible; }
    @keyframes spin { to { transform: rotate(360deg); } }

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

  function build() {
    const host = document.createElement("div");
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
            <span class="badge"></span>
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
    refs.panel.addEventListener("click", () => refs.input.focus());
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

    const st = await chrome.runtime.sendMessage({ type: "palette-state" }).catch(() => null);
    if (!isOpen) return;
    refs.badge.textContent = st?.env ?? "";
    refs.badge.hidden = !st?.env;
    setStatus(st?.connected);
    if (st && !st.connected) renderLogin();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(timer);
    seq++; // toute réponse en vol devient périmée
    refs.overlay.classList.remove("open");
    setTimeout(() => {
      if (!isOpen) refs.host.style.display = "none";
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
    const res = await chrome.runtime.sendMessage({ type: "palette-search", text }).catch((e) => ({ ok: false, error: String(e) }));
    if (mySeq !== seq || !isOpen) return; // frappe plus récente partie depuis
    setSpinner(false);
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
      const res = await chrome.runtime.sendMessage({ type: "login" }).catch(() => null);
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
    chrome.runtime.sendMessage({ type: "palette-open", url: record.url, background }).catch(() => {});
    if (!background) close();
  }

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent ?? "";
  }
})();
