import { execFile, spawn } from "child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import https from "https";
import { homedir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { t } from "./i18n";
import { RepoManagerView } from "./reposView";

const execFileAsync = promisify(execFile);

type Conversation = {
  composerId: string;
  name: string;
  projectIdentifier: string;
  projectPath: string;
  workspaceDir: string;
  status: string;
  projectTracked?: boolean;
};

type StatusPayload = {
  conversations?: Conversation[];
  error?: string;
};

type GhResponse = { status: number; json: Record<string, unknown> };

const queued = new Set<string>();
let extensionPath = "";
let storageDir = "";
let pythonBin = "";
let cliPath = "";
let cursavesOverride = "";
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;
let busy = false;
let inflight: Promise<void> | undefined;
let warnedStatus = false;
let connectInflight: Promise<string> | undefined;
let syncLog: vscode.OutputChannel | undefined;
let syncStatus: vscode.StatusBarItem | undefined;
let repoPanel: RepoManagerView | undefined;
let syncPhase: "need-repos" | "syncing" | "synced" | "error" = "syncing";
let statusDetail = "";
let progressTitle = t("同步中", "Syncing");
const progressLines: string[] = [];
let warnedNoRemote = false;
let noRemoteUntil = 0;
let folderWarning = "";
let folderWarningShownAt = 0;
let booted = false;
let booting = false;
let askedAuth = false;
let repoScanTimer: ReturnType<typeof setTimeout> | undefined;
let gitWatchTimer: ReturnType<typeof setTimeout> | undefined;
let originKey = "";

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  storageDir = context.globalStorageUri.fsPath;
  const reposView = new RepoManagerView(
    async (args, timeout) => {
      if (!(await ensureCli())) {
        throw new Error(t("同步程序还没准备好", "The sync program is not ready"));
      }
      return runCursaves(args, timeout);
    },
    async () => {
      schedule();
      await poll();
    },
    () => {
      void noteCurrentFolder();
    },
  );
  repoPanel = reposView;
  syncLog = vscode.window.createOutputChannel(t("会话同步", "Session Sync"));
  syncStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  syncStatus.command = "cursorSessionSync.showProgress";
  syncStatus.show();
  context.subscriptions.push(
    syncLog,
    syncStatus,
    vscode.window.registerWebviewViewProvider("cursorSessionSync.repos", reposView),
    vscode.commands.registerCommand("cursorSessionSync.connect", () => connectGitHub()),
    vscode.commands.registerCommand("cursorSessionSync.configure", () => configure()),
    vscode.commands.registerCommand("cursorSessionSync.manageRepos", () => {
      void vscode.commands.executeCommand("cursorSessionSync.repos.focus");
    }),
    vscode.commands.registerCommand("cursorSessionSync.checkNow", () => poll()),
    vscode.window.onDidChangeActiveColorTheme(() => {
      repoPanel?.setColorScheme(cursorScheme());
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && !booted) {
        void startup();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      warnedNoRemote = false;
      originKey = "";
      void noteCurrentFolder();
      repoPanel?.rescan();
    }),
    watchGitConfig(),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cursorSessionSync.language")) {
        void refreshLanguage();
      }
    }),
    vscode.commands.registerCommand("cursorSessionSync.showProgress", () => {
      if (syncPhase === "need-repos" || syncPhase === "syncing") {
        void vscode.commands.executeCommand("cursorSessionSync.repos.focus");
        return;
      }
      syncLog?.show(true);
    }),
  );
  setSyncState("syncing", t("正在准备同步程序", "Preparing the sync program"));
  void startup();
}

export async function deactivate(): Promise<void> {
  stopped = true;
  if (repoScanTimer) {
    clearTimeout(repoScanTimer);
    repoScanTimer = undefined;
  }
  if (gitWatchTimer) {
    clearTimeout(gitWatchTimer);
    gitWatchTimer = undefined;
  }
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (inflight) {
    await inflight.catch(() => undefined);
  }
  launchPendingImport();
}

async function startup(): Promise<void> {
  if (booted || booting) {
    return;
  }
  booting = true;
  try {
    if (!(await ensureCli())) {
      return;
    }
    if (!(await syncRemote())) {
      void noteCurrentFolder();
      if (!vscode.window.state.focused) {
        return;
      }
      if (askedAuth) {
        return;
      }
      askedAuth = true;
      const allow = t("授权", "Authorize");
      const choice = await vscode.window.showInformationMessage(
        t(
          "会话同步会在你的 GitHub 上建立私有仓库。点授权后按弹窗登录，不用填 token，也不用配 SSH。",
          "Session sync creates a private repository on your GitHub. Choose Authorize and sign in. No token or SSH setup.",
        ),
        allow,
      );
      if (choice !== allow || !(await connectGitHub())) {
        return;
      }
    }
    booted = true;
    schedule();
    await poll();
    await noteCurrentFolder();
  } finally {
    booting = false;
    scheduleRepoScan();
  }
}

function scheduleRepoScan(): void {
  if (repoScanTimer || !cliReady()) {
    return;
  }
  repoScanTimer = setTimeout(() => {
    repoScanTimer = undefined;
    if (!stopped) {
      repoPanel?.warm();
    }
  }, 1500);
}

function schedule(): void {
  if (timer) {
    clearInterval(timer);
  }
  const seconds = Math.max(5, config().get<number>("pollSeconds") ?? 60);
  timer = setInterval(() => {
    void poll();
  }, seconds * 1000);
}

async function poll(): Promise<void> {
  if (stopped || busy || !cliReady()) {
    return;
  }
  if (!hasRepoSelection()) {
    setSyncState("need-repos", t("还没有勾选仓库，本机会话不会上传。请打开侧边栏「会话同步」，勾选后点保存。", "No repositories are selected, so local chats are not uploaded. Open Session Sync in the sidebar, check repositories, and save."));
    return;
  }
  busy = true;
  setSyncState("syncing", t("正在检查本机会话", "Checking local chats"));
  const run = doPoll();
  inflight = run;
  try {
    await run;
  } catch (err) {
    setSyncState("error", t(`同步失败：${errorText(err)}`, `Sync failed: ${errorText(err)}`));
  } finally {
    busy = false;
    if (inflight === run) {
      inflight = undefined;
    }
  }
}

async function doPoll(): Promise<void> {
  const cfg = config();
  const args = ["status", "--json"];
  const includeRemote = (cfg.get<string>("includeRemote") ?? "").trim();
  const excludeRemote = (cfg.get<string>("excludeRemote") ?? "").trim();
  const maxAgeDays = cfg.get<number>("maxAgeDays") ?? 0;
  if (includeRemote) {
    args.push("--include-remote", includeRemote);
  }
  if (excludeRemote) {
    args.push("--exclude-remote", excludeRemote);
  }
  if (maxAgeDays > 0) {
    args.push("--max-age-days", String(maxAgeDays));
  }

  let stdout = "";
  try {
    stdout = (await runCursaves(args)).stdout;
  } catch (err) {
    const statusError = t(`同步状态检查失败：${errorText(err)}`, `Could not check sync status: ${errorText(err)}`);
    setSyncState("error", statusError);
    if (!warnedStatus) {
      warnedStatus = true;
      void vscode.window.showErrorMessage(statusError);
    }
    return;
  }

  let payload: StatusPayload;
  try {
    payload = JSON.parse(stdout) as StatusPayload;
  } catch {
    setSyncState("error", t("同步状态没有返回 JSON", "Sync status did not return JSON"));
    if (!warnedStatus) {
      warnedStatus = true;
      void vscode.window.showErrorMessage(t("同步状态没有返回 JSON。", "Sync status did not return JSON."));
    }
    return;
  }
  warnedStatus = false;

  const conversations = payload.conversations ?? [];
  const ahead = conversations.filter((row) => row.status === "local_ahead" && row.projectPath);
  note(t(`勾选的仓库里有 ${ahead.length} 个会话需要从本机上传`, `${ahead.length} chats in selected repositories need uploading`));
  const exported = await exportAhead(ahead);
  const published = await publishSnapshots(ahead.length === 0);
  if (published) {
    for (const id of exported.ids) {
      queued.add(`push:${id}`);
    }
  }
  if (!exported.ok || !published) {
    return;
  }
  setSyncState("synced", ahead.length ? t(`已上传 ${ahead.length} 个会话`, `Uploaded ${ahead.length} chats`) : t("没有新的本机会话需要上传", "No new local chats to upload"));
  await queueIncoming(conversations.filter((row) => row.status === "new" || row.status === "incoming_newer"));
  await promptDiverged(conversations.filter((row) => row.status === "diverged"));
}

async function exportAhead(rows: Conversation[]): Promise<{ ok: boolean; ids: string[] }> {
  const groups = new Map<string, Conversation[]>();
  const ids: string[] = [];
  for (const row of rows) {
    if (!row.projectPath || !row.composerId) {
      continue;
    }
    const key = `${row.projectPath}\n${row.workspaceDir}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  let ok = true;
  for (const list of groups.values()) {
    const fresh = list.filter((row) => !queued.has(`push:${row.composerId}`));
    if (fresh.length === 0) {
      continue;
    }
    const args = ["push", "--no-push", "-p", fresh[0].projectPath];
    if (fresh[0].workspaceDir) {
      args.push("-w", basename(fresh[0].workspaceDir));
    }
    for (const row of fresh) {
      args.push("--composer", row.composerId);
    }
    const label = fresh.map((row) => row.name || row.composerId).join("、");
    setSyncState("syncing", t(`正在写入本地快照 ${label}`, `Writing local snapshot ${label}`));
    try {
      const result = await runCursaves(args);
      note([result.stdout, result.stderr].filter((part) => part.trim()).join("\n"));
      for (const row of fresh) {
        if (row.composerId) {
          ids.push(row.composerId);
        }
      }
    } catch (err) {
      ok = false;
      const uploadError = t(`写入本地快照失败：${errorText(err)}`, `Could not write the local snapshot: ${errorText(err)}`);
      setSyncState("error", uploadError);
      void vscode.window.showErrorMessage(uploadError);
    }
  }
  return { ok, ids };
}

async function publishSnapshots(quiet: boolean): Promise<boolean> {
  if (!quiet) {
    setSyncState("syncing", t("正在提交并推送", "Committing and pushing"));
  }
  try {
    const result = await runCursaves(["push", "--publish"]);
    const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
    if (output && !output.includes("Nothing to push")) {
      note(output);
    }
    return true;
  } catch (err) {
    const uploadError = t(`推送失败：${errorText(err)}`, `Push failed: ${errorText(err)}`);
    setSyncState("error", uploadError);
    void vscode.window.showErrorMessage(t(`推送会话失败：${errorText(err)}`, `Could not push chats: ${errorText(err)}`));
    return false;
  }
}

async function queueIncoming(rows: Conversation[]): Promise<void> {
  const already = pendingComposerIds();
  const fresh = rows.filter((row) =>
    row.composerId && row.projectIdentifier && !queued.has(`import:${row.composerId}`) && !already.has(row.composerId),
  );
  const names: string[] = [];
  for (const row of fresh) {
    if (await enqueue(row, "import")) {
      queued.add(`import:${row.composerId}`);
      names.push(row.name || t("未命名", "Untitled"));
    }
  }
  if (names.length === 1) {
    void vscode.window.showInformationMessage(t(`会话「${names[0]}」有远端更新，退出 Cursor 后会自动导入。`, `“${names[0]}” has a remote update. It imports after Cursor quits.`));
  } else if (names.length > 1) {
    void vscode.window.showInformationMessage(t(`有 ${names.length} 个会话有远端更新，退出 Cursor 后会自动导入。`, `${names.length} chats have remote updates. They import after Cursor quits.`));
  }
}

async function promptDiverged(rows: Conversation[]): Promise<void> {
  const policy = config().get<string>("onDiverged") ?? "ask";
  const already = pendingComposerIds();
  for (const row of rows) {
    if (!row.composerId || !row.projectIdentifier || queued.has(`diverged:${row.composerId}`) || already.has(row.composerId)) {
      continue;
    }
    if (policy === "fork" || policy === "skip" || policy === "merge") {
      if (await enqueue(row, policy)) {
        queued.add(`diverged:${row.composerId}`);
        const chatName = row.name || t("未命名", "Untitled");
        void vscode.window.showInformationMessage(
          t(`会话「${chatName}」两边都有新消息，退出后按 ${policy} 处理。`, `“${chatName}” has new messages on both sides. After quit it will ${policy}.`),
        );
      }
      continue;
    }
    const chatName = row.name || t("未命名", "Untitled");
    const choice = await vscode.window.showInformationMessage(
      t(`会话「${chatName}」两边都有新消息。退出后如何处理？`, `“${chatName}” has new messages on both sides. What should happen after quit?`),
      "Fork",
      "Skip",
      "Merge",
    );
    const action = choice === "Fork" ? "fork" : choice === "Skip" ? "skip" : choice === "Merge" ? "merge" : "";
    if (!action) {
      queued.add(`diverged:${row.composerId}`);
      continue;
    }
    if (await enqueue(row, action)) {
      queued.add(`diverged:${row.composerId}`);
    }
  }
}

async function enqueue(row: Conversation, action: string): Promise<boolean> {
  try {
    await runCursaves([
      "import-pending",
      "enqueue",
      "--composer",
      row.composerId,
      "--project-id",
      row.projectIdentifier,
      "--action",
      action,
    ], 30_000);
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(t(`写入待导入队列失败：${errorText(err)}`, `Could not queue the import: ${errorText(err)}`));
    return false;
  }
}

function launchPendingImport(): void {
  if (!cliReady()) {
    return;
  }
  const queuePath = join(homedir(), ".config", "cursaves", "pending_import.json");
  if (!existsSync(queuePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(queuePath, "utf8")) as { items?: unknown[] };
    if (!parsed.items || parsed.items.length === 0) {
      return;
    }
  } catch {
    return;
  }
  const spec = cursavesCommand(["import-pending"]);
  const child = spawn(spec.cmd, spec.args, { detached: true, stdio: "ignore", env: spec.env });
  child.unref();
}

async function configure(): Promise<void> {
  if (!(await ensureCli())) {
    return;
  }
  if (!(await syncRemote())) {
    const connected = await connectGitHub();
    if (!connected) {
      return;
    }
  }
  const cfg = config();
  const pollSeconds = await vscode.window.showInputBox({
    title: t("轮询秒数", "Poll interval in seconds"),
    value: String(cfg.get<number>("pollSeconds") ?? 60),
    ignoreFocusOut: true,
  });
  if (pollSeconds === undefined) {
    return;
  }
  const maxAgeDays = await vscode.window.showInputBox({
    title: t("最大会话天数（0 表示不限制）", "Maximum chat age in days (0 means no limit)"),
    value: String(cfg.get<number>("maxAgeDays") ?? 0),
    ignoreFocusOut: true,
  });
  if (maxAgeDays === undefined) {
    return;
  }
  const onDiverged = await vscode.window.showQuickPick(
    [
      { label: "ask", description: t("每次询问 fork / skip / merge", "Ask each time: fork / skip / merge") },
      { label: "fork", description: t("远端复制成新会话", "Copy the remote chat into a new chat") },
      { label: "skip", description: t("跳过冲突", "Skip the conflict") },
      { label: "merge", description: t("并集消息，checkpoint 留本机", "Union of messages; checkpoints stay local") },
    ],
    { title: t("默认冲突策略", "Default conflict policy"), ignoreFocusOut: true },
  );
  if (!onDiverged) {
    return;
  }

  const target = vscode.ConfigurationTarget.Global;
  const seconds = Number(pollSeconds);
  await cfg.update("pollSeconds", Number.isFinite(seconds) && seconds >= 5 ? seconds : 60, target);
  const age = Number(maxAgeDays);
  await cfg.update("maxAgeDays", Number.isFinite(age) && age > 0 ? age : 0, target);
  await cfg.update("onDiverged", onDiverged.label, target);
  schedule();
  await poll();
}

async function connectGitHub(): Promise<string> {
  if (connectInflight) {
    return connectInflight;
  }
  connectInflight = connectGitHubLocked().finally(() => {
    connectInflight = undefined;
  });
  return connectInflight;
}

async function connectGitHubLocked(): Promise<string> {
  if (!(await ensureCli())) {
    return "";
  }
  let release: (() => Promise<void>) | undefined;
  try {
    const lock = await acquireConnectLock();
    release = lock.release;
    const existing = displayRemote(await syncRemote());
    if (existing) {
      await config().update("remoteUrl", existing, vscode.ConfigurationTarget.Global);
      if (vscode.window.state.focused) {
        void vscode.window.showInformationMessage(
          lock.waited
            ? t(`另一个窗口已经连上：${existing}`, `Another window already connected: ${existing}`)
            : t(`私有快照仓库已连接：${existing}`, `Private snapshot repository connected: ${existing}`),
        );
      }
      schedule();
      return existing;
    }
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("连接 GitHub", "Connect GitHub") },
      async () => {
        const session = await vscode.authentication.getSession("github", ["repo"], { createIfNone: true });
        const user = await githubUser(session.accessToken);
        const displayUrl = cleanGitHubUrl(await ensurePrivateRepo(session.accessToken, user.login));
        const cloneUrl = withTokenUser(displayUrl);
        const email = `${user.id}+${user.login}@users.noreply.github.com`;
        const gitEnv = {
          GIT_AUTHOR_NAME: user.login,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: user.login,
          GIT_COMMITTER_EMAIL: email,
        };
        await runCursaves(["init", "--remote", cloneUrl], 60_000, gitEnv);
        const dir = join(homedir(), ".cursaves");
        await execFileAsync("git", ["-C", dir, "config", "user.name", user.login]);
        await execFileAsync("git", ["-C", dir, "config", "user.email", email]);
        if (process.platform === "darwin") {
          await execFileAsync("git", ["-C", dir, "config", "credential.helper", "osxkeychain"]);
        }
        await rememberGitHub(session.accessToken);
        await publishSnapshotRepo(dir);
        await config().update("remoteUrl", displayUrl, vscode.ConfigurationTarget.Global);
        if (vscode.window.state.focused) {
          void vscode.window.showInformationMessage(t(`私有快照仓库已连接：${displayUrl}`, `Private snapshot repository connected: ${displayUrl}`));
        }
        schedule();
        return cloneUrl;
      },
    );
  } catch (err) {
    const message = errorText(err);
    if (!/cancel|did not consent/i.test(message)) {
      void vscode.window.showErrorMessage(t(`GitHub 授权失败：${message}`, `GitHub authorization failed: ${message}`));
    }
    return "";
  } finally {
    await release?.();
  }
}

function acquireConnectLock(): Promise<{ release: () => Promise<void>; waited: boolean }> {
  const dir = join(homedir(), ".config", "cursaves");
  mkdirSync(dir, { recursive: true });
  const child = spawn(pythonBin || "python3", ["-c", CONNECT_LOCK_SCRIPT, join(dir, "connect.lock")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = Date.now();
  const notice = setTimeout(() => {
    if (vscode.window.state.focused) {
      void vscode.window.showInformationMessage(t("另一个窗口正在连接 GitHub，这个窗口会等它完成。", "Another window is connecting to GitHub. This window will wait."));
    }
  }, 300);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(notice);
      reject(err);
    };
    let output = "";
    child.on("error", fail);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (settled || !output.includes("locked")) {
        return;
      }
      settled = true;
      clearTimeout(notice);
      resolve({
        waited: Date.now() - started > 300,
        release: () =>
          new Promise((done) => {
            child.once("close", () => done());
            child.stdin?.end();
          }),
      });
    });
    child.on("close", () => {
      fail(new Error(t("授权锁提前退出", "The authorization lock exited early")));
    });
  });
}

const CONNECT_LOCK_SCRIPT = `
import fcntl, sys
handle = open(sys.argv[1], "a")
fcntl.flock(handle, fcntl.LOCK_EX)
print("locked", flush=True)
sys.stdin.read()
`;

async function githubUser(token: string): Promise<{ login: string; id: number }> {
  const response = await gh(token, "GET", "/user");
  const login = response.json.login;
  const id = response.json.id;
  if (response.status !== 200 || typeof login !== "string" || typeof id !== "number") {
    throw new Error(t("读不到 GitHub 账号", "Could not read the GitHub account"));
  }
  return { login, id };
}

async function ensurePrivateRepo(token: string, login: string): Promise<string> {
  for (const name of ["cursor-saves", "cursor-session-sync"]) {
    const existing = await gh(token, "GET", `/repos/${login}/${name}`);
    if (existing.status === 200) {
      if (existing.json.private !== true || typeof existing.json.clone_url !== "string") {
        continue;
      }
      return existing.json.clone_url;
    }
    if (existing.status !== 404) {
      continue;
    }
    const created = await gh(token, "POST", "/user/repos", {
      name,
      private: true,
      description: "Private Cursor session snapshots",
    });
    if (created.status === 201 && created.json.private === true && typeof created.json.clone_url === "string") {
      return created.json.clone_url;
    }
  }
  throw new Error(t("没有可用的私有仓库。同名仓库如果是公开的，扩展不会往里面写会话。", "No private repository is available. A public repository with the same name is left untouched."));
}

async function publishSnapshotRepo(dir: string): Promise<void> {
  try {
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: dir, timeout: 120_000 });
  } catch (pushError) {
    try {
      await execFileAsync("git", ["fetch", "origin"], { cwd: dir, timeout: 120_000 });
      await execFileAsync("git", ["checkout", "-f", "-B", "main", "origin/main"], { cwd: dir, timeout: 30_000 });
    } catch {
      throw pushError;
    }
  }
}

function rememberGitHub(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", "approve"], { stdio: ["pipe", "ignore", "pipe"] });
    if (!child.stdin) {
      reject(new Error(t("无法把 GitHub 登录保存到系统钥匙串", "Could not save the GitHub login to the system keychain")));
      return;
    }
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(err.trim() || t("无法把 GitHub 登录保存到系统钥匙串", "Could not save the GitHub login to the system keychain")));
      }
    });
    child.stdin.end(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n`);
  });
}

function gh(token: string, method: string, path: string, body?: unknown): Promise<GhResponse> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "cursor-session-sync",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          if (text) {
            try {
              json = JSON.parse(text) as Record<string, unknown>;
            } catch {
              json = { message: text };
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function withTokenUser(url: string): string {
  const parsed = new URL(cleanGitHubUrl(url));
  parsed.username = "x-access-token";
  parsed.password = "";
  return parsed.toString();
}

function displayRemote(url: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function cleanGitHubUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password) {
    throw new Error(t("仓库地址不是不带凭据的 GitHub HTTPS 地址", "The repository URL is not a GitHub HTTPS address without credentials"));
  }
  return url;
}

async function syncRemote(): Promise<string> {
  const dir = join(homedir(), ".cursaves");
  if (!existsSync(join(dir, ".git"))) {
    return "";
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function ensureCli(): Promise<boolean> {
  const configured = (config().get<string>("cursavesPath") ?? "").trim();
  if (configured) {
    try {
      await execFileAsync(configured, ["--version"], { timeout: 15_000 });
      cursavesOverride = configured;
      return true;
    } catch {
      cursavesOverride = "";
    }
  }
  cliPath = resolveCliRoot();
  if (!existsSync(join(cliPath, "cursor_saves", "__main__.py"))) {
    void vscode.window.showErrorMessage(t("扩展自带的同步程序不可用。", "The bundled sync program is unavailable."));
    return false;
  }
  try {
    pythonBin = await findPython();
  } catch (err) {
    void vscode.window.showErrorMessage(t(`没能自动安装 Python：${errorText(err)}`, `Could not install Python: ${errorText(err)}`));
    return false;
  }
  if (!pythonBin) {
    void vscode.window.showErrorMessage(t("没能自动安装 Python。", "Could not install Python."));
    return false;
  }
  try {
    await runCursaves(["--version"], 15_000);
  } catch (err) {
    void vscode.window.showErrorMessage(t(`同步程序无法启动：${errorText(err)}`, `The sync program failed to start: ${errorText(err)}`));
    return false;
  }
  return true;
}

async function findPython(): Promise<string> {
  const existing = await locatePython();
  if (existing) {
    return existing;
  }
  return installPython();
}

async function locatePython(): Promise<string> {
  const installed = await pythonFromUvInstall();
  if (installed) {
    return installed;
  }
  const cltReady = process.platform !== "darwin" || await commandOk("xcode-select", ["-p"]);
  const dirs = [
    ...(process.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    "/Library/Frameworks/Python.framework/Versions/Current/bin",
  ];
  for (const version of ["3.13", "3.12", "3.11", "3.10"]) {
    dirs.push(`/Library/Frameworks/Python.framework/Versions/${version}/bin`);
  }
  const names = ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    for (const name of names) {
      const bin = join(dir, name);
      if (!cltReady && bin === "/usr/bin/python3") {
        continue;
      }
      if (await pythonOk(bin)) {
        return bin;
      }
    }
  }
  return "";
}

async function pythonFromUvInstall(): Promise<string> {
  const uv = findNamed(join(storageDir, "uv"), "uv");
  const pyDir = join(storageDir, "python");
  if (!uv || !existsSync(pyDir)) {
    return "";
  }
  try {
    const { stdout } = await execFileAsync(uv, ["python", "find", "3.12"], {
      env: { ...process.env, UV_PYTHON_INSTALL_DIR: pyDir },
      timeout: 20_000,
    });
    const bin = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    return (await pythonOk(bin)) ? bin : "";
  } catch {
    return "";
  }
}

async function installPython(): Promise<string> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("正在准备 Python，只需这一次", "Preparing Python, just this once") },
    async () => {
      const uv = await ensureUv();
      const pyDir = join(storageDir, "python");
      mkdirSync(pyDir, { recursive: true });
      const env = { ...process.env, UV_PYTHON_INSTALL_DIR: pyDir };
      await execFileAsync(uv, ["python", "install", "3.12"], { env, timeout: 300_000 });
      if (process.platform === "darwin") {
        await execFileAsync("xattr", ["-dr", "com.apple.quarantine", pyDir]).catch(() => undefined);
      }
      const { stdout } = await execFileAsync(uv, ["python", "find", "3.12"], { env, timeout: 20_000 });
      const bin = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      if (!(await pythonOk(bin))) {
        throw new Error(t("Python 下载后无法运行", "The downloaded Python could not be run"));
      }
      return bin;
    },
  );
}

async function ensureUv(): Promise<string> {
  const existing = findNamed(join(storageDir, "uv"), "uv");
  if (existing && await commandOk(existing, ["--version"])) {
    return existing;
  }
  for (const candidate of ["uv", join(homedir(), ".local", "bin", "uv")]) {
    if (await commandOk(candidate, ["--version"])) {
      return candidate;
    }
  }
  const dir = join(storageDir, "uv");
  mkdirSync(dir, { recursive: true });
  const asset = uvAsset();
  const archive = join(dir, asset);
  await execFileAsync("curl", ["-fsSL", `https://github.com/astral-sh/uv/releases/latest/download/${asset}`, "-o", archive], {
    timeout: 120_000,
  });
  await execFileAsync("tar", ["-xzf", archive, "-C", dir], { timeout: 60_000 });
  const unpacked = findNamed(dir, "uv");
  if (!unpacked) {
    throw new Error(t("Python 安装器解压后没有找到 uv", "uv was not found after extracting the Python installer"));
  }
  chmodSync(unpacked, 0o755);
  if (process.platform === "darwin") {
    await execFileAsync("xattr", ["-d", "com.apple.quarantine", unpacked]).catch(() => undefined);
  }
  return unpacked;
}

function uvAsset(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") {
    return `uv-${arch}-apple-darwin.tar.gz`;
  }
  if (process.platform === "linux") {
    return `uv-${arch}-unknown-linux-gnu.tar.gz`;
  }
  throw new Error(t("这个系统不能自动安装 Python", "Python cannot be installed automatically on this system"));
}

function findNamed(dir: string, name: string, depth = 3): string {
  if (!dir || !existsSync(dir) || depth < 0) {
    return "";
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) {
      return path;
    }
    if (entry.isDirectory()) {
      const nested = findNamed(path, name, depth - 1);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}

async function pythonOk(bin: string): Promise<boolean> {
  if (!bin || (bin.includes("/") && !existsSync(bin))) {
    return false;
  }
  return commandOk(bin, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"]);
}

async function commandOk(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

function resolveCliRoot(): string {
  const bundled = join(extensionPath, "vendor", "cursaves");
  if (existsSync(join(bundled, "cursor_saves", "__main__.py"))) {
    return bundled;
  }
  return join(extensionPath, "..", "cli");
}

function cliReady(): boolean {
  return Boolean(cursavesOverride || (pythonBin && cliPath));
}

function cursavesCommand(args: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (cursavesOverride) {
    return { cmd: cursavesOverride, args, env: process.env };
  }
  return {
    cmd: pythonBin,
    args: ["-m", "cursor_saves", ...args],
    env: { ...process.env, PYTHONPATH: cliPath },
  };
}

async function runCursaves(
  args: string[],
  timeout = 180_000,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const spec = cursavesCommand(args);
  return execFileAsync(spec.cmd, spec.args, {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: extraEnv ? { ...spec.env, ...extraEnv } : spec.env,
  });
}

function pendingComposerIds(): Set<string> {
  const queuePath = join(homedir(), ".config", "cursaves", "pending_import.json");
  if (!existsSync(queuePath)) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(readFileSync(queuePath, "utf8")) as { items?: { composerId?: string }[] };
    return new Set((parsed.items ?? []).map((item) => item.composerId).filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}

async function refreshLanguage(): Promise<void> {
  const hadFolderWarning = folderWarning !== "";
  folderWarning = "";
  warnedNoRemote = false;
  noRemoteUntil = 0;
  repoPanel?.applyLanguage();
  if (hadFolderWarning) {
    await noteCurrentFolder();
  }
  if (!folderWarning && statusDetail) {
    setSyncState(syncPhase, statusDetail);
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("cursorSessionSync");
}

function hasRepoSelection(): boolean {
  if (config().get<boolean>("reposChosen") !== true) {
    return false;
  }
  const include = (config().get<string>("includeRemote") ?? "").trim();
  return include.length > 0 && include !== "__none__";
}

function setSyncState(state: "need-repos" | "syncing" | "synced" | "error", detail: string): void {
  syncPhase = state;
  statusDetail = detail;
  progressTitle = {
    "need-repos": t("未选择仓库", "No repositories"),
    syncing: t("同步中", "Syncing"),
    synced: t("已同步", "Synced"),
    error: t("同步失败", "Sync failed"),
  }[state];
  const label = {
    "need-repos": `$(repo) ${t("未选择仓库", "No repositories")}`,
    syncing: `$(sync~spin) ${t("同步中", "Syncing")}`,
    synced: `$(check) ${t("已同步", "Synced")}`,
    error: `$(error) ${t("同步失败", "Sync failed")}`,
  }[state];
  const clickHint = state === "need-repos" || state === "syncing" ? t("点击打开侧边栏", "Click to open the sidebar") : t("点击查看进度", "Click to view progress");
  const holdFolderWarning = folderWarning !== "" && (state === "need-repos" || Date.now() - folderWarningShownAt < 12000);
  if (syncStatus && !holdFolderWarning && Date.now() >= noRemoteUntil) {
    syncStatus.text = label;
    syncStatus.tooltip = `${detail}${t("（", " (")}${clickHint}${t("）", ")")}`;
  }
  note(detail);
}

async function noteCurrentFolder(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return;
  }
  let sawRepo = false;
  let sawRemote = false;
  for (const folder of folders) {
    const kind = await folderGitKind(folder.uri.fsPath);
    if (kind === "remote") {
      sawRemote = true;
    } else if (kind === "noremote") {
      sawRepo = true;
    }
  }
  if (sawRemote) {
    const wasWarning = folderWarning !== "";
    folderWarning = "";
    noRemoteUntil = 0;
    if (wasWarning) {
      warnedNoRemote = false;
      setSyncState(syncPhase, t("当前文件夹已有 Git 远程", "The current folder has a Git remote"));
    }
    return;
  }
  const text = sawRepo ? t("当前文件夹没有 Git 远程", "The current folder has no Git remote") : t("当前文件夹不是 Git 仓库", "The current folder is not a Git repository");
  if (warnedNoRemote && folderWarning === text) {
    return;
  }
  warnedNoRemote = true;
  folderWarning = text;
  folderWarningShownAt = Date.now();
  noRemoteUntil = Date.now() + 12000;
  if (!syncStatus) {
    void vscode.window.setStatusBarMessage(`$(warning) ${text}${t("，不会出现在同步列表", ", so it will not appear in the sync list")}`, 12000);
    return;
  }
  syncStatus.text = `$(warning) ${text}`;
  syncStatus.tooltip = `${text}${t("，不会出现在同步列表", ", so it will not appear in the sync list")}`;
}

function watchGitConfig(): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher("**/.git/config");
  const kick = () => scheduleGitRescan();
  watcher.onDidChange(kick);
  watcher.onDidCreate(kick);
  void rememberOrigin();
  return watcher;
}

function scheduleGitRescan(): void {
  if (gitWatchTimer) {
    clearTimeout(gitWatchTimer);
  }
  gitWatchTimer = setTimeout(() => {
    gitWatchTimer = undefined;
    if (stopped) {
      return;
    }
    void rescanIfOriginChanged();
  }, 600);
}

async function rememberOrigin(): Promise<void> {
  const key = await currentOriginKey();
  if (!originKey) {
    originKey = key;
  }
}

async function rescanIfOriginChanged(): Promise<void> {
  const next = await currentOriginKey();
  if (next === originKey) {
    return;
  }
  originKey = next;
  warnedNoRemote = false;
  void noteCurrentFolder();
  repoPanel?.rescan();
}

function currentOriginKey(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return Promise.all(folders.map(async (folder) => `${folder.uri.fsPath}\t${await folderGitKind(folder.uri.fsPath)}`)).then((parts) =>
    parts.join("\n"),
  );
}

function folderGitKind(dir: string): Promise<"remote" | "noremote" | "norepo"> {
  if (!existsSync(join(dir, ".git"))) {
    return Promise.resolve("norepo");
  }
  return execFileAsync("git", ["-C", dir, "config", "--get", "remote.origin.url"], { timeout: 8000 })
    .then(({ stdout }) => (stdout.trim() ? "remote" as const : "noremote" as const))
    .catch(() => "noremote" as const);
}

function cursorScheme(): "light" | "dark" {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) {
    return "light";
  }
  return "dark";
}

function note(message: string): void {
  const text = message.trim();
  if (!text) {
    return;
  }
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = `[${stamp}] ${text}`;
  progressLines.push(line);
  if (progressLines.length > 30) {
    progressLines.shift();
  }
  syncLog?.appendLine(line);
  repoPanel?.setProgress(progressTitle, progressLines);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message.replace(/ghp_[A-Za-z0-9]+/g, "[token]").replace(/github_pat_[A-Za-z0-9_]+/g, "[token]");
  }
  return String(err);
}
