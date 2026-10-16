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
exports.LookmlProject = exports.Warnings = exports.MAIN = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const minimatch_1 = require("minimatch");
const parser_1 = require("./parser");
exports.MAIN = '';
class Warnings {
    set = new Set();
    add(msg) {
        this.set.add(msg);
    }
    list() {
        return [...this.set];
    }
}
exports.Warnings = Warnings;
function walk(dir, out) {
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        if (name === '.git' || name === 'node_modules')
            continue;
        const p = path.join(dir, name);
        let st;
        try {
            st = fs.statSync(p);
        }
        catch {
            continue;
        }
        if (st.isDirectory())
            walk(p, out);
        else if (name.endsWith('.lkml'))
            out.push(p);
    }
}
/**
 * Loads LookML files lazily, resolves `include:` statements (globs, `//project/` prefixes)
 * and exposes manifest constants.
 */
class LookmlProject {
    warnings = new Warnings();
    roots = new Map();
    /** Remote names that point at the main project folder itself (e.g. `//one-crm-spoke/`). */
    selfAliases = new Set();
    fileLists = new Map(); // project -> relPaths
    cache = new Map();
    constants = new Map();
    constructor(opts) {
        this.roots.set(exports.MAIN, path.resolve(opts.root));
        const mainRoot = path.resolve(opts.root).toLowerCase();
        for (const [name, dir] of Object.entries(opts.remoteProjects ?? {})) {
            if (!dir)
                continue;
            if (path.resolve(dir).toLowerCase() === mainRoot)
                this.selfAliases.add(name);
            else
                this.roots.set(name, path.resolve(dir));
        }
        // dependencies declared in the main manifest; any other `//name/` is taken as this project itself
        this.declaredDeps = new Set((this.getFile(exports.MAIN, '/manifest.lkml')?.entries ?? [])
            .filter((e) => (e.key === 'remote_dependency' || e.key === 'local_dependency') && e.name)
            .map((e) => e.name));
        this.loadConstants();
    }
    declaredDeps;
    get root() {
        return this.roots.get(exports.MAIN);
    }
    loadConstants() {
        // remote manifests first so the main project's values win
        const order = [...this.roots.keys()].filter((p) => p !== exports.MAIN).concat(exports.MAIN);
        for (const proj of order) {
            const f = this.getFile(proj, '/manifest.lkml');
            if (!f)
                continue;
            for (const e of f.entries) {
                if (e.key === 'constant' && e.name && e.value.kind === 'block') {
                    const v = (0, parser_1.getText)(e.value.entries, 'value');
                    if (v !== undefined)
                        this.constants.set(e.name, v);
                }
                if (e.key === 'override_constant' && e.name && e.value.kind === 'block') {
                    const v = (0, parser_1.getText)(e.value.entries, 'value');
                    if (v !== undefined)
                        this.constants.set(e.name, v);
                }
            }
        }
    }
    /** Replace `@{constant}` references. Unknown constants are left untouched. */
    applyConstants(text) {
        return text.replace(/@\{\s*(\w+)\s*\}/g, (m, name) => this.constants.has(name) ? this.constants.get(name) : m);
    }
    listFiles(project) {
        let list = this.fileLists.get(project);
        if (!list) {
            const root = this.roots.get(project);
            const abs = [];
            if (root)
                walk(root, abs);
            list = abs.map((p) => '/' + path.relative(root, p).split(path.sep).join('/')).sort();
            this.fileLists.set(project, list);
        }
        return list;
    }
    getFile(project, relPath) {
        const key = `${project}::${relPath}`;
        if (this.cache.has(key))
            return this.cache.get(key) ?? undefined;
        const root = this.roots.get(project);
        let result = null;
        if (root) {
            const absPath = path.join(root, ...relPath.split('/').filter(Boolean));
            if (fs.existsSync(absPath)) {
                try {
                    const text = fs.readFileSync(absPath, 'utf8');
                    result = { project, relPath, absPath, entries: (0, parser_1.parseLookml)(text) };
                }
                catch (err) {
                    this.warnings.add(`Parse error in ${absPath}: ${err.message}`);
                }
            }
        }
        this.cache.set(key, result);
        return result ?? undefined;
    }
    /** Find the file object for an absolute path inside the main project. */
    fileFromAbsPath(absPath) {
        for (const [proj, root] of this.roots) {
            const rel = path.relative(root, absPath);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                return this.getFile(proj, '/' + rel.split(path.sep).join('/'));
            }
        }
        return undefined;
    }
    /** Resolve one include pattern relative to the including file. */
    resolveInclude(pattern, from) {
        let project = from.project;
        let pat = pattern.trim();
        const remote = /^\/\/([^/]+)(\/.*)$/.exec(pat);
        if (remote) {
            const isSelf = this.selfAliases.has(remote[1]) || (!this.roots.has(remote[1]) && !this.declaredDeps.has(remote[1]));
            project = isSelf ? exports.MAIN : remote[1];
            pat = remote[2];
            if (!this.roots.has(project)) {
                this.warnings.add(`Remote project "${project}" is not mapped to a local folder (setting lookmlDoc.remoteProjects) - include "${pattern}" skipped`);
                return [];
            }
        }
        else if (!pat.startsWith('/')) {
            const dir = path.posix.dirname(from.relPath);
            pat = path.posix.normalize(path.posix.join(dir, pat));
        }
        if (!/\.(lkml|lookml)$/.test(pat) && !pat.endsWith('*'))
            pat += '.lkml';
        const files = this.listFiles(project).filter((f) => (0, minimatch_1.minimatch)(f, pat, { dot: true }));
        if (files.length === 0 && !/\.lookml$/.test(pat)) {
            this.warnings.add(`Include "${pattern}" (from ${from.relPath}) matched no files`);
        }
        return files.map((f) => this.getFile(project, f)).filter((f) => !!f);
    }
    /** All files reachable from `start` through include statements, in include order (start first). */
    reachableFiles(start) {
        const seen = new Set();
        const out = [];
        const visit = (f) => {
            const key = `${f.project}::${f.relPath}`;
            if (seen.has(key))
                return;
            seen.add(key);
            out.push(f);
            for (const e of f.entries) {
                if (e.key !== 'include')
                    continue;
                const pats = e.value.kind === 'scalar' ? [e.value.text]
                    : e.value.kind === 'list' ? e.value.items.filter((i) => i.kind === 'scalar').map((i) => i.text)
                        : [];
                for (const p of pats)
                    for (const inc of this.resolveInclude(p, f))
                        visit(inc);
            }
        };
        visit(start);
        return out;
    }
    modelFiles() {
        return this.listFiles(exports.MAIN)
            .filter((f) => f.endsWith('.model.lkml'))
            .map((f) => this.getFile(exports.MAIN, f))
            .filter((f) => !!f);
    }
}
exports.LookmlProject = LookmlProject;
//# sourceMappingURL=project.js.map