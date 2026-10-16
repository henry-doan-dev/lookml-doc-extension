"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
let output;
function activate(context) {
    output = vscode.window.createOutputChannel('LookML Explore Doc');
    context.subscriptions.push(output, vscode.commands.registerCommand('lookmlDoc.generateExplore', (uri, exploreName) => run(() => generateExplore(uri, exploreName))), vscode.commands.registerCommand('lookmlDoc.generateModel', () => run(generateModel)), vscode.languages.registerCodeLensProvider({ pattern: '**/*.lkml' }, new ExploreCodeLens()));
}
function deactivate() { }
async function run(fn) {
    try {
        await fn();
    }
    catch (err) {
        const msg = err.message ?? String(err);
        output.appendLine(`ERROR: ${msg}`);
        vscode.window.showErrorMessage(`LookML Doc: ${msg}`);
    }
}
// ---------------------------------------------------------------------------
function workspaceRoot(hint) {
    const folder = (hint && vscode.workspace.getWorkspaceFolder(hint)) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        throw new Error('Open the LookML project folder first.');
    return folder.uri.fsPath;
}
function openProject(root) {
    const cfg = vscode.workspace.getConfiguration('lookmlDoc');
    const remotes = {};
    for (const [name, dir] of Object.entries(cfg.get('remoteProjects') ?? {})) {
        remotes[name] = dir.replace(/\$\{workspaceFolder\}/g, root);
    }
    return new core_1.LookmlProject({ root, remoteProjects: remotes });
}
function modelName(file) {
    return path.posix.basename(file.relPath).replace(/\.model\.lkml$/, '');
}
async function pickModel(project, candidates) {
    const files = candidates ?? project.modelFiles();
    if (!files.length)
        throw new Error('No *.model.lkml file found in the workspace.');
    let chosen = files[0];
    if (files.length > 1) {
        const pick = await vscode.window.showQuickPick(files.map((f) => ({ label: modelName(f), description: f.relPath, file: f })), { placeHolder: 'Select a model' });
        if (!pick)
            return undefined;
        chosen = pick.file;
    }
    return withProgress(`Loading model ${modelName(chosen)}...`, async () => new core_1.LookmlModel(project, chosen));
}
async function askOutputPath(root, baseName) {
    const cfg = vscode.workspace.getConfiguration('lookmlDoc');
    const dir = cfg.get('outputDir') || path.dirname(root);
    return vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(dir, `${baseName}.xlsx`)),
        filters: { Excel: ['xlsx'] },
    });
}
function withProgress(title, task) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}
async function writeAndReport(docs, project, target) {
    const projectWarnings = project.warnings.list();
    for (const d of docs)
        d.warnings.unshift(...projectWarnings.filter((w) => !d.warnings.includes(w)));
    await withProgress('Writing Excel...', () => (0, core_1.writeWorkbook)(docs, target.fsPath));
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${target.fsPath}`);
    for (const d of docs)
        output.appendLine(`  ${d.model} / ${d.explore}: ${d.rows.length} fields, ${d.warnings.length} warnings`);
    const total = docs.reduce((n, d) => n + d.rows.length, 0);
    const action = await vscode.window.showInformationMessage(`LookML Doc: ${total} fields documented (${docs.length} explore${docs.length > 1 ? 's' : ''}).`, 'Open file', 'Show folder');
    if (action === 'Open file')
        await vscode.env.openExternal(target);
    if (action === 'Show folder')
        await vscode.commands.executeCommand('revealFileInOS', target);
}
// ---------------------------------------------------------------------------
async function generateExplore(uri, exploreName) {
    const root = workspaceRoot(uri ?? vscode.window.activeTextEditor?.document.uri);
    const project = openProject(root);
    // When launched from a CodeLens, only offer the models that include this explore file.
    let candidates;
    if (uri) {
        const file = project.fileFromAbsPath(uri.fsPath);
        if (file) {
            candidates = project.modelFiles().filter((m) => m === file || project.reachableFiles(m).some((f) => f.project === file.project && f.relPath === file.relPath));
            if (!candidates.length)
                throw new Error(`${file.relPath} is not included by any model.`);
        }
    }
    const model = await pickModel(project, candidates);
    if (!model)
        return;
    let explore = exploreName;
    if (!explore) {
        const pick = await vscode.window.showQuickPick(model.exploreNames().map((name) => {
            const e = model.getExplore(name);
            const label = e ? e.entries.find((x) => x.key === 'label') : undefined;
            return {
                label: name,
                description: label && label.value.kind === 'scalar' ? label.value.text : '',
                detail: model.exploreFile(name)?.relPath,
            };
        }), { placeHolder: `Select an explore in ${model.name}` });
        if (!pick)
            return;
        explore = pick.label;
    }
    const doc = await withProgress(`Documenting ${explore}...`, async () => (0, core_1.documentExplore)(model, explore));
    const target = await askOutputPath(root, `${model.name}__${explore}`);
    if (!target)
        return;
    await writeAndReport([doc], project, target);
}
async function generateModel() {
    const root = workspaceRoot(vscode.window.activeTextEditor?.document.uri);
    const project = openProject(root);
    const model = await pickModel(project);
    if (!model)
        return;
    const names = model.exploreNames();
    const picks = await vscode.window.showQuickPick(names.map((n) => ({ label: n, picked: true })), { canPickMany: true, placeHolder: 'Explores to include (one sheet each)' });
    if (!picks || !picks.length)
        return;
    const docs = await withProgress(`Documenting ${picks.length} explores...`, async () => picks.map((p) => (0, core_1.documentExplore)(model, p.label)));
    const target = await askOutputPath(root, model.name);
    if (!target)
        return;
    await writeAndReport(docs, project, target);
}
// ---------------------------------------------------------------------------
class ExploreCodeLens {
    provideCodeLenses(document) {
        if (!vscode.workspace.getConfiguration('lookmlDoc').get('codeLens', true))
            return [];
        const lenses = [];
        const re = /^\s*explore:\s*([A-Za-z0-9_&]+)\s*\{/;
        for (let i = 0; i < document.lineCount; i++) {
            const m = re.exec(document.lineAt(i).text);
            if (!m)
                continue;
            lenses.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
                title: '$(file-text) Generate Doc (Excel)',
                command: 'lookmlDoc.generateExplore',
                arguments: [document.uri, m[1]],
            }));
        }
        return lenses;
    }
}
//# sourceMappingURL=extension.js.map