import * as path from 'path';
import * as vscode from 'vscode';
import { documentExplore, ExploreDoc, LookmlModel, LookmlProject, writeWorkbook } from './core';
import { LkmlFile } from './core/project';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('LookML Explore Doc');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('lookmlDoc.generateExplore', (uri?: vscode.Uri, exploreName?: string) =>
      run(() => generateExplore(uri, exploreName))),
    vscode.commands.registerCommand('lookmlDoc.generateModel', () => run(generateModel)),
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.lkml' }, new ExploreCodeLens()),
  );
}

export function deactivate(): void {}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    output.appendLine(`ERROR: ${msg}`);
    vscode.window.showErrorMessage(`LookML Doc: ${msg}`);
  }
}

// ---------------------------------------------------------------------------

function workspaceRoot(hint?: vscode.Uri): string {
  const folder = (hint && vscode.workspace.getWorkspaceFolder(hint)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open the LookML project folder first.');
  return folder.uri.fsPath;
}

function openProject(root: string): LookmlProject {
  const cfg = vscode.workspace.getConfiguration('lookmlDoc');
  const remotes: Record<string, string> = {};
  for (const [name, dir] of Object.entries(cfg.get<Record<string, string>>('remoteProjects') ?? {})) {
    remotes[name] = dir.replace(/\$\{workspaceFolder\}/g, root);
  }
  return new LookmlProject({ root, remoteProjects: remotes });
}

function modelName(file: LkmlFile): string {
  return path.posix.basename(file.relPath).replace(/\.model\.lkml$/, '');
}

async function pickModel(project: LookmlProject, candidates?: LkmlFile[]): Promise<LookmlModel | undefined> {
  const files = candidates ?? project.modelFiles();
  if (!files.length) throw new Error('No *.model.lkml file found in the workspace.');
  let chosen = files[0];
  if (files.length > 1) {
    const pick = await vscode.window.showQuickPick(
      files.map((f) => ({ label: modelName(f), description: f.relPath, file: f })),
      { placeHolder: 'Select a model' },
    );
    if (!pick) return undefined;
    chosen = pick.file;
  }
  return withProgress(`Loading model ${modelName(chosen)}...`, async () => new LookmlModel(project, chosen));
}

async function askOutputPath(root: string, baseName: string): Promise<vscode.Uri | undefined> {
  const cfg = vscode.workspace.getConfiguration('lookmlDoc');
  const dir = cfg.get<string>('outputDir') || path.dirname(root);
  return vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, `${baseName}.xlsx`)),
    filters: { Excel: ['xlsx'] },
  });
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

async function writeAndReport(docs: ExploreDoc[], project: LookmlProject, target: vscode.Uri): Promise<void> {
  const projectWarnings = project.warnings.list();
  for (const d of docs) d.warnings.unshift(...projectWarnings.filter((w) => !d.warnings.includes(w)));
  await withProgress('Writing Excel...', () => writeWorkbook(docs, target.fsPath));

  output.appendLine(`[${new Date().toLocaleTimeString()}] ${target.fsPath}`);
  for (const d of docs) output.appendLine(`  ${d.model} / ${d.explore}: ${d.rows.length} fields, ${d.warnings.length} warnings`);
  const total = docs.reduce((n, d) => n + d.rows.length, 0);
  const action = await vscode.window.showInformationMessage(
    `LookML Doc: ${total} fields documented (${docs.length} explore${docs.length > 1 ? 's' : ''}).`,
    'Open file', 'Show folder',
  );
  if (action === 'Open file') await vscode.env.openExternal(target);
  if (action === 'Show folder') await vscode.commands.executeCommand('revealFileInOS', target);
}

// ---------------------------------------------------------------------------

async function generateExplore(uri?: vscode.Uri, exploreName?: string): Promise<void> {
  const root = workspaceRoot(uri ?? vscode.window.activeTextEditor?.document.uri);
  const project = openProject(root);

  // When launched from a CodeLens, only offer the models that include this explore file.
  let candidates: LkmlFile[] | undefined;
  if (uri) {
    const file = project.fileFromAbsPath(uri.fsPath);
    if (file) {
      candidates = project.modelFiles().filter((m) =>
        m === file || project.reachableFiles(m).some((f) => f.project === file.project && f.relPath === file.relPath));
      if (!candidates.length) throw new Error(`${file.relPath} is not included by any model.`);
    }
  }
  const model = await pickModel(project, candidates);
  if (!model) return;

  let explore = exploreName;
  if (!explore) {
    const pick = await vscode.window.showQuickPick(
      model.exploreNames().map((name) => {
        const e = model.getExplore(name);
        const label = e ? e.entries.find((x) => x.key === 'label') : undefined;
        return {
          label: name,
          description: label && label.value.kind === 'scalar' ? label.value.text : '',
          detail: model.exploreFile(name)?.relPath,
        };
      }),
      { placeHolder: `Select an explore in ${model.name}` },
    );
    if (!pick) return;
    explore = pick.label;
  }

  const doc = await withProgress(`Documenting ${explore}...`, async () => documentExplore(model, explore!));
  const target = await askOutputPath(root, `${model.name}__${explore}`);
  if (!target) return;
  await writeAndReport([doc], project, target);
}

async function generateModel(): Promise<void> {
  const root = workspaceRoot(vscode.window.activeTextEditor?.document.uri);
  const project = openProject(root);
  const model = await pickModel(project);
  if (!model) return;

  const names = model.exploreNames();
  const picks = await vscode.window.showQuickPick(
    names.map((n) => ({ label: n, picked: true })),
    { canPickMany: true, placeHolder: 'Explores to include (one sheet each)' },
  );
  if (!picks || !picks.length) return;

  const docs = await withProgress(`Documenting ${picks.length} explores...`, async () =>
    picks.map((p) => documentExplore(model, p.label)));
  const target = await askOutputPath(root, model.name);
  if (!target) return;
  await writeAndReport(docs, project, target);
}

// ---------------------------------------------------------------------------

class ExploreCodeLens implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('lookmlDoc').get<boolean>('codeLens', true)) return [];
    const lenses: vscode.CodeLens[] = [];
    const re = /^\s*explore:\s*([A-Za-z0-9_&]+)\s*\{/;
    for (let i = 0; i < document.lineCount; i++) {
      const m = re.exec(document.lineAt(i).text);
      if (!m) continue;
      lenses.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
        title: '$(file-text) Generate Doc (Excel)',
        command: 'lookmlDoc.generateExplore',
        arguments: [document.uri, m[1]],
      }));
    }
    return lenses;
  }
}
