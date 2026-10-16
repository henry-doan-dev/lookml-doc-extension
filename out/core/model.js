"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBlock = exports.LookmlModel = exports.FIELD_KINDS = void 0;
exports.isFieldKind = isFieldKind;
exports.mergeEntries = mergeEntries;
const parser_1 = require("./parser");
Object.defineProperty(exports, "getBlock", { enumerable: true, get: function () { return parser_1.getBlock; } });
exports.FIELD_KINDS = ['dimension', 'dimension_group', 'measure', 'parameter', 'filter'];
function isFieldKind(key) {
    return exports.FIELD_KINDS.includes(key);
}
/** Keys that may legitimately appear several times inside one block. */
const REPEATABLE = new Set(['include', 'allowed_value', 'link', 'action', 'access_filter', 'bind_filters', 'column', 'derived_column', 'filter_expression']);
function namespaceOf(key) {
    return isFieldKind(key) ? 'field' : key;
}
/** Merge `overlay` onto `base` following LookML override semantics (later wins, named blocks merge by name). */
function mergeEntries(base, overlay) {
    const out = base.slice();
    for (const e of overlay) {
        if (e.name !== undefined) {
            const ns = namespaceOf(e.key);
            const idx = out.findIndex((o) => o.name === e.name && namespaceOf(o.key) === ns);
            if (idx >= 0 && out[idx].value.kind === 'block' && e.value.kind === 'block') {
                out[idx] = { ...e, value: { kind: 'block', entries: mergeEntries(out[idx].value.entries, e.value.entries) } };
            }
            else if (idx >= 0) {
                out[idx] = e;
            }
            else {
                out.push(e);
            }
            continue;
        }
        if (REPEATABLE.has(e.key)) {
            out.push(e);
            continue;
        }
        const idx = findLastIndex(out, (o) => o.key === e.key && o.name === undefined);
        if (e.key === 'extends' && idx >= 0) {
            // refinements add to the extends list
            const prev = (0, parser_1.getList)([out[idx]], 'extends') ?? [];
            const next = (0, parser_1.getList)([e], 'extends') ?? [];
            const merged = [...new Set([...prev, ...next])];
            out[idx] = { ...e, value: { kind: 'list', items: merged.map((t) => ({ kind: 'scalar', text: t, quoted: false })) } };
        }
        else if (idx >= 0 && out[idx].value.kind === 'block' && e.value.kind === 'block') {
            out[idx] = { ...e, value: { kind: 'block', entries: mergeEntries(out[idx].value.entries, e.value.entries) } };
        }
        else if (idx >= 0) {
            out[idx] = e;
        }
        else {
            out.push(e);
        }
    }
    return out;
}
function findLastIndex(arr, pred) {
    for (let i = arr.length - 1; i >= 0; i--)
        if (pred(arr[i]))
            return i;
    return -1;
}
/** Everything reachable from one model file. */
class LookmlModel {
    project;
    modelFile;
    name;
    files;
    viewBases = new Map();
    viewRefinements = new Map();
    exploreBases = new Map();
    exploreRefinements = new Map();
    viewCache = new Map();
    exploreCache = new Map();
    constructor(project, modelFile) {
        this.project = project;
        this.modelFile = modelFile;
        this.name = modelFile.relPath.split('/').pop().replace(/\.model\.lkml$/, '');
        this.files = project.reachableFiles(modelFile);
        for (const f of this.files)
            this.index(f);
    }
    index(f) {
        for (const e of f.entries) {
            if ((e.key !== 'view' && e.key !== 'explore') || !e.name || e.value.kind !== 'block')
                continue;
            const isRef = e.name.startsWith('+');
            const name = isRef ? e.name.slice(1) : e.name;
            const def = { entries: e.value.entries, file: f };
            if (e.key === 'view') {
                if (isRef)
                    push(this.viewRefinements, name, def);
                else if (this.viewBases.has(name)) {
                    const prev = this.viewBases.get(name);
                    if (prev.file !== f)
                        this.project.warnings.add(`View "${name}" defined in both ${prev.file.relPath} and ${f.relPath}; using the first`);
                }
                else
                    this.viewBases.set(name, def);
            }
            else {
                if (isRef)
                    push(this.exploreRefinements, name, def);
                else if (!this.exploreBases.has(name))
                    this.exploreBases.set(name, def);
            }
        }
    }
    exploreNames() {
        return [...this.exploreBases.keys()];
    }
    exploreFile(name) {
        return this.exploreBases.get(name)?.file;
    }
    hasView(name) {
        return this.viewBases.has(name) || this.viewRefinements.has(name);
    }
    getView(name, stack = []) {
        if (this.viewCache.has(name))
            return this.viewCache.get(name) ?? undefined;
        if (stack.includes(name)) {
            this.project.warnings.add(`Circular extends: ${[...stack, name].join(' -> ')}`);
            return undefined;
        }
        const base = this.viewBases.get(name);
        const refs = this.viewRefinements.get(name) ?? [];
        if (!base && refs.length === 0) {
            this.viewCache.set(name, null);
            return undefined;
        }
        if (!base) {
            this.project.warnings.add(`View "${name}" has refinements but no base definition (is its project mapped in lookmlDoc.remoteProjects?)`);
        }
        let own = base ? base.entries : [];
        for (const r of refs)
            own = mergeEntries(own, r.entries);
        let merged = [];
        let partial = !base;
        for (const parent of (0, parser_1.getList)(own, 'extends') ?? []) {
            const pv = this.getView(parent, [...stack, name]);
            if (!pv) {
                this.project.warnings.add(`View "${name}" extends unknown view "${parent}" (is its project mapped in lookmlDoc.remoteProjects?)`);
                partial = true;
                continue;
            }
            if (pv.partial)
                partial = true;
            merged = mergeEntries(merged, pv.entries.filter((e) => e.key !== 'extends' && e.key !== 'extension'));
        }
        merged = mergeEntries(merged, own);
        const fields = new Map();
        const sets = new Map();
        for (const e of merged) {
            if (isFieldKind(e.key) && e.name && e.value.kind === 'block') {
                fields.set(e.name, { kind: e.key, name: e.name, entries: e.value.entries });
            }
            else if (e.key === 'set' && e.name && e.value.kind === 'block') {
                sets.set(e.name, (0, parser_1.getList)(e.value.entries, 'fields') ?? []);
            }
        }
        const view = { name, entries: merged, fields, sets, partial };
        this.viewCache.set(name, view);
        return view;
    }
    getExplore(name, stack = []) {
        if (this.exploreCache.has(name))
            return this.exploreCache.get(name) ?? undefined;
        const base = this.exploreBases.get(name);
        if (!base || stack.includes(name))
            return undefined;
        let own = base.entries;
        for (const r of this.exploreRefinements.get(name) ?? [])
            own = mergeEntries(own, r.entries);
        let merged = [];
        for (const parent of (0, parser_1.getList)(own, 'extends') ?? []) {
            const pe = this.getExplore(parent, [...stack, name]);
            if (pe)
                merged = mergeEntries(merged, pe.entries.filter((e) => e.key !== 'extends' && e.key !== 'extension'));
            else
                this.project.warnings.add(`Explore "${name}" extends unknown explore "${parent}"`);
        }
        merged = mergeEntries(merged, own);
        const baseAlias = (0, parser_1.getText)(merged, 'view_name') ?? name;
        const baseView = (0, parser_1.getText)(merged, 'from') ?? (0, parser_1.getText)(merged, 'view_name') ?? name;
        const aliases = [{ alias: baseAlias, viewName: baseView, isBase: true }];
        for (const e of merged) {
            if (e.key !== 'join' || !e.name || e.value.kind !== 'block')
                continue;
            const j = e.value.entries;
            aliases.push({ alias: e.name, viewName: (0, parser_1.getText)(j, 'from') ?? (0, parser_1.getText)(j, 'view_name') ?? e.name, isBase: false, join: j });
        }
        const explore = { name, entries: merged, aliases, file: base.file };
        this.exploreCache.set(name, explore);
        return explore;
    }
}
exports.LookmlModel = LookmlModel;
function push(m, k, v) {
    const arr = m.get(k);
    if (arr)
        arr.push(v);
    else
        m.set(k, [v]);
}
//# sourceMappingURL=model.js.map