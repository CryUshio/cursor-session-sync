import * as vscode from "vscode";

export function isChinese(): boolean {
  const choice = vscode.workspace.getConfiguration("cursorSessionSync").get<string>("language") ?? "auto";
  if (choice === "zh") {
    return true;
  }
  if (choice === "en") {
    return false;
  }
  return vscode.env.language.toLowerCase().startsWith("zh");
}

export function t(zh: string, en: string): string {
  return isChinese() ? zh : en;
}
