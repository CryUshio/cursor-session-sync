import * as vscode from "vscode";
import { t } from "./i18n";

export type SyncRepo = {
  id: string;
  remote: string;
  name: string;
  paths: string[];
  tracked: boolean;
  current?: boolean;
};

type Runner = (args: string[], timeout?: number) => Promise<{ stdout: string }>;

type RepoCache = { repos: SyncRepo[]; currentRemote: boolean };

export class RepoManagerView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pendingPaint = false;
  private progressTitle = t("同步中", "Syncing");
  private progressLines: string[] = [];
  // ponytail: one in-memory list per window. New chats stay hidden until Refresh or a folder change.
  private cache: RepoCache | undefined;
  private scanning: Promise<void> | undefined;
  private generation = 0;

  private colorScheme = cursorColorScheme();

  constructor(
    private readonly run: Runner,
    private readonly onSaved: () => Promise<void>,
    private readonly onNoRemote: () => void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.title = t("同步仓库", "Sync Repositories");
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: { type?: string; ids?: string[] }) => {
      if (message.type === "save") {
        void this.save(message.ids ?? []);
      } else if (message.type === "refresh") {
        void this.load(true);
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.pendingPaint) {
        void this.load();
      }
    });
    if (webviewView.visible) {
      void this.load();
    } else {
      this.pendingPaint = true;
    }
  }

  warm(): void {
    if (this.cache || this.scanning) {
      return;
    }
    void this.scan(false);
  }

  rescan(): void {
    void this.load(true);
  }

  setProgress(title: string, lines: string[]): void {
    this.progressTitle = title;
    this.progressLines = lines.slice(-30);
    void this.view?.webview.postMessage({
      type: "progress",
      title: this.progressTitle,
      lines: this.progressLines,
    });
  }

  setColorScheme(scheme: "light" | "dark"): void {
    this.colorScheme = scheme;
    void this.view?.webview.postMessage({ type: "theme", scheme });
  }

  applyLanguage(): void {
    if (this.view) {
      this.view.title = t("同步仓库", "Sync Repositories");
    }
    if (this.view?.visible && this.cache) {
      this.render();
      return;
    }
    this.pendingPaint = true;
  }

  async load(force = false): Promise<void> {
    if (!this.view?.visible) {
      this.pendingPaint = true;
      if (force || (!this.cache && !this.scanning)) {
        void this.scan(force);
      }
      return;
    }
    if (!force && this.cache) {
      this.render();
      return;
    }
    if (!force && this.scanning) {
      if (!this.cache) {
        this.renderScanning();
      }
      await this.scanning;
      return;
    }
    this.renderScanning();
    await this.scan(force);
  }

  private scan(force: boolean): Promise<void> {
    if (!force && this.scanning) {
      return this.scanning;
    }
    const gen = ++this.generation;
    const job = this.readRepos().then((result) => {
      if (gen !== this.generation) {
        return;
      }
      this.cache = result;
      if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0 && !result.currentRemote) {
        this.onNoRemote();
      }
      if (this.view?.visible) {
        this.render();
      } else {
        this.pendingPaint = true;
      }
    }).catch((err: unknown) => {
      if (gen !== this.generation) {
        return;
      }
      this.renderError(err);
    }).finally(() => {
      if (this.scanning === job) {
        this.scanning = undefined;
      }
    });
    this.scanning = job;
    return job;
  }

  private async readRepos(): Promise<RepoCache> {
    const args = ["repos", "--json"];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      args.push("--current", folder.uri.fsPath);
    }
    const { stdout } = await this.run(args, 60_000);
    const payload = JSON.parse(stdout) as { repos?: SyncRepo[]; currentRemote?: boolean };
    return { repos: payload.repos ?? [], currentRemote: payload.currentRemote !== false };
  }

  private render(): void {
    const webview = this.view?.webview;
    if (!webview || !this.view?.visible || !this.cache) {
      this.pendingPaint = true;
      return;
    }
    this.pendingPaint = false;
    webview.html = this.page(this.cache.repos, checkedIds(this.cache.repos), "");
  }

  private renderScanning(): void {
    const webview = this.view?.webview;
    if (!webview || !this.view?.visible) {
      this.pendingPaint = true;
      return;
    }
    this.pendingPaint = false;
    webview.html = this.page([], new Set(), "", true);
  }

  private renderError(err: unknown): void {
    const webview = this.view?.webview;
    if (!webview || !this.view?.visible) {
      this.pendingPaint = true;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.pendingPaint = false;
    webview.html = this.page([], new Set(), message);
  }

  private page(repos: SyncRepo[], checked: Set<string>, error: string, scanning = false): string {
    const webview = this.view?.webview;
    if (!webview) {
      return "";
    }
    return renderPage(
      repos,
      checked,
      error,
      this.progressTitle,
      this.progressLines,
      webview,
      this.colorScheme,
      scanning,
    );
  }

  private async save(ids: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("cursorSessionSync");
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update("includeRemote", ids.length ? ids.join(",") : "__none__", target);
    await cfg.update("excludeRemote", "", target);
    await cfg.update("reposChosen", true, target);
    void vscode.window.showInformationMessage(
      ids.length
        ? t(`将同步 ${ids.length} 个仓库，马上从本机上传。`, `Syncing ${ids.length} repositories. Uploading local chats now.`)
        : t("没有勾选仓库，本机不会上传。", "No repositories are checked, so nothing is uploaded."),
    );
    await this.onSaved();
    if (this.cache && this.view?.visible) {
      this.render();
    } else {
      await this.load();
    }
  }
}

function checkedIds(repos: SyncRepo[]): Set<string> {
  const cfg = vscode.workspace.getConfiguration("cursorSessionSync");
  const chosen = cfg.get<boolean>("reposChosen") === true;
  const patterns = (cfg.get<string>("includeRemote") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part !== "__none__");
  if (!chosen && patterns.length === 0) {
    return new Set(repos.filter((repo) => repo.tracked).map((repo) => repo.id));
  }
  return new Set(repos.filter((repo) => patterns.some((pattern) => matches(repo, pattern))).map((repo) => repo.id));
}

const folderIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.5h4l1.2 1.4H14.5V13a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5v-10A.5.5 0 0 1 2 2.5z"/></svg>`;

function matches(repo: SyncRepo, pattern: string): boolean {
  return pattern === repo.id;
}

function renderPage(
  repos: SyncRepo[],
  checked: Set<string>,
  error: string,
  progressTitle: string,
  progressLines: string[],
  webview: vscode.Webview,
  colorScheme: "light" | "dark",
  scanning = false,
): string {
  const rows = repos.map((repo) => {
    const remote = repo.remote || repo.id;
    const where = repo.current ? t("当前窗口", "This window") : "";
    const pathHtml = repo.paths.length
      ? repo.paths.map((item) => `<span class="path">${folderIcon}<span>${escapeHtml(item)}</span></span>`).join("")
      : `<span class="meta">${escapeHtml(t("这台电脑上还没打开", "Not opened on this computer"))}</span>`;
    return `<label class="row">
      <input type="checkbox" value="${escapeAttr(repo.id)}" ${checked.has(repo.id) ? "checked" : ""}>
      <span>
        <span class="name">${escapeHtml(repo.name)}${where ? ` · ${escapeHtml(where)}` : ""}</span>
        <span class="meta">${escapeHtml(remote)}</span>
        ${pathHtml}
      </span>
    </label>`;
  }).join("");
  const empty = scanning || repos.length
    ? ""
    : `<p class="meta">${escapeHtml(t("没有发现有对话的仓库。", "No repositories with chats were found."))}</p>`;
  const scanningNote = scanning ? `<p class="meta">${escapeHtml(t("正在扫描有对话的仓库…", "Scanning repositories that have chats…"))}</p>` : "";
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="${colorScheme}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { background: var(--vscode-sideBar-background); color: var(--vscode-sideBar-foreground); color-scheme: ${colorScheme}; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 12px 14px 24px; }
  h2, .name, #progress-title { color: var(--vscode-foreground); }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 6px; }
  .hint, .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .hint { margin: 0 0 12px; line-height: 1.4; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--vscode-widget-border); cursor: pointer; }
  .name, .meta { display: block; word-break: break-all; white-space: pre-wrap; }
  .path { display: flex; gap: 4px; align-items: flex-start; color: var(--vscode-descriptionForeground); font-size: 12px; word-break: break-all; }
  .path svg { width: 14px; height: 14px; flex: 0 0 14px; margin-top: 1px; fill: var(--vscode-foreground); }
  .name { font-size: 13px; }
  .error { color: var(--vscode-errorForeground); }
  input[type="checkbox"] { margin-top: 2px; accent-color: var(--vscode-focusBorder); }
  #q { width: 100%; box-sizing: border-box; margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; }
  #q::placeholder { color: var(--vscode-input-placeholderForeground); }
  .progress { background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 8px 10px; margin: 0 0 12px; max-height: 9em; overflow: auto; }
  .progress strong { display: block; font-size: 13px; margin-bottom: 4px; }
  .progress pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <section class="progress">
    <strong id="progress-title">${escapeHtml(progressTitle)}</strong>
    <pre id="progress-log">${escapeHtml(progressLines.join("\n") || t("还没有进度", "No progress yet"))}</pre>
  </section>
  <h2>${escapeHtml(t("同步哪些仓库", "Which repositories to sync"))}</h2>
  <p class="hint">${escapeHtml(t("只列出有对话的仓库。保存后，只同步勾选的仓库。", "Only repositories with chats are listed. After you save, only checked repositories are synced."))}</p>
  ${errorHtml}
  <input id="q" type="search" placeholder="${escapeAttr(t("过滤仓库", "Filter repositories"))}">
  <div class="toolbar">
    <button id="all" class="secondary" type="button">${escapeHtml(t("全选", "All"))}</button>
    <button id="none" class="secondary" type="button">${escapeHtml(t("全不选", "None"))}</button>
    <button id="save" type="button">${escapeHtml(t("保存", "Save"))}</button>
  </div>
  <form id="repos">${rows}</form>
  ${scanningNote}
  ${empty}
  <script>
    const vscode = acquireVsCodeApi();
    const rows = () => Array.from(document.querySelectorAll('#repos .row'));
    const boxes = () => Array.from(document.querySelectorAll('#repos input[type="checkbox"]'));
    const visibleBoxes = () => rows().filter((row) => row.style.display !== 'none').flatMap((row) => {
      const box = row.querySelector('input');
      return box ? [box] : [];
    });
    const queryBox = document.getElementById('q');
    if (queryBox) {
      queryBox.oninput = () => {
        const query = queryBox.value.toLowerCase();
        rows().forEach((row) => {
          row.style.display = row.innerText.toLowerCase().includes(query) ? '' : 'none';
        });
      };
    }
    const all = document.getElementById('all');
    const none = document.getElementById('none');
    const save = document.getElementById('save');
    if (all) all.onclick = () => visibleBoxes().forEach((box) => { box.checked = true; });
    if (none) none.onclick = () => visibleBoxes().forEach((box) => { box.checked = false; });
    if (save) {
      save.onclick = () => {
        vscode.postMessage({ type: 'save', ids: boxes().filter((box) => box.checked).map((box) => box.value) });
      };
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === 'theme') {
        document.documentElement.style.colorScheme = message.scheme || '';
        return;
      }
      if (message.type !== 'progress') return;
      const title = document.getElementById('progress-title');
      const log = document.getElementById('progress-log');
      if (title) title.textContent = message.title || '';
      if (log) log.textContent = (message.lines || []).join('\\n') || ${JSON.stringify(t("还没有进度", "No progress yet"))};
    });
  </script>
</body>
</html>`;
}

function cursorColorScheme(): "light" | "dark" {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) {
    return "light";
  }
  return "dark";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
