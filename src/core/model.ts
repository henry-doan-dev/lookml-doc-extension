import { Entry, getBlock, getList, getText } from './parser';
import { LkmlFile, LookmlProject } from './project';

export const FIELD_KINDS = ['dimension', 'dimension_group', 'measure', 'parameter', 'filter'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export function isFieldKind(key: string): key is FieldKind {
  return (FIELD_KINDS as readonly string[]).includes(key);
}

export interface FieldDef {
  kind: FieldKind;
  name: string;
  entries: Entry[];
}

export interface ResolvedView {
  name: string;
  /** Merged view-level entries (base + refinements, with extends applied). */
  entries: Entry[];
  /** Fields in definition order. */
  fields: Map<string, FieldDef>;
  sets: Map<string, string[]>;
  /** True when the base `view:` or one of its extends parents was not found (e.g. hub not mapped). */
  partial: boolean;
}

export interface ExploreAlias {
  alias: string;
  viewName: string;
  isBase: boolean;
  /** The join block entries (undefined for the base view). */
  join?: Entry[];
}

export interface ResolvedExplore {
  name: string;
  entries: Entry[];
  aliases: ExploreAlias[];
  file: LkmlFile;
}

/** Keys that may legitimately appear several times inside one block. */
const REPEATABLE = new Set(['include', 'allowed_value', 'link', 'action', 'access_filter', 'bind_filters', 'column', 'derived_column', 'filter_expression']);

function namespaceOf(key: string): string {
  return isFieldKind(key) ? 'field' : key;
}

/** Merge `overlay` onto `base` following LookML override semantics (later wins, named blocks merge by name). */
export function mergeEntries(base: Entry[], overlay: Entry[]): Entry[] {
  const out = base.slice();
  for (const e of overlay) {
    if (e.name !== undefined) {
      const ns = namespaceOf(e.key);
      const idx = out.findIndex((o) => o.name === e.name && namespaceOf(o.key) === ns);
      if (idx >= 0 && out[idx].value.kind === 'block' && e.value.kind === 'block') {
        out[idx] = { ...e, value: { kind: 'block', entries: mergeEntries(out[idx].value.entries as Entry[], e.value.entries) } };
      } else if (idx >= 0) {
        out[idx] = e;
      } else {
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
      const prev = getList([out[idx]], 'extends') ?? [];
      const next = getList([e], 'extends') ?? [];
      const merged = [...new Set([...prev, ...next])];
      out[idx] = { ...e, value: { kind: 'list', items: merged.map((t) => ({ kind: 'scalar', text: t, quoted: false })) } };
    } else if (idx >= 0 && out[idx].value.kind === 'block' && e.value.kind === 'block') {
      out[idx] = { ...e, value: { kind: 'block', entries: mergeEntries(out[idx].value.entries as Entry[], e.value.entries) } };
    } else if (idx >= 0) {
      out[idx] = e;
    } else {
      out.push(e);
    }
  }
  return out;
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

interface Def {
  entries: Entry[];
  file: LkmlFile;
}

/** Everything reachable from one model file. */
export class LookmlModel {
  readonly name: string;
  readonly files: LkmlFile[];
  private readonly viewBases = new Map<string, Def>();
  private readonly viewRefinements = new Map<string, Def[]>();
  private readonly exploreBases = new Map<string, Def>();
  private readonly exploreRefinements = new Map<string, Def[]>();
  private readonly viewCache = new Map<string, ResolvedView | null>();
  private readonly exploreCache = new Map<string, ResolvedExplore | null>();

  constructor(readonly project: LookmlProject, readonly modelFile: LkmlFile) {
    this.name = modelFile.relPath.split('/').pop()!.replace(/\.model\.lkml$/, '');
    this.files = project.reachableFiles(modelFile);
    for (const f of this.files) this.index(f);
  }

  private index(f: LkmlFile): void {
    for (const e of f.entries) {
      if ((e.key !== 'view' && e.key !== 'explore') || !e.name || e.value.kind !== 'block') continue;
      const isRef = e.name.startsWith('+');
      const name = isRef ? e.name.slice(1) : e.name;
      const def: Def = { entries: e.value.entries, file: f };
      if (e.key === 'view') {
        if (isRef) push(this.viewRefinements, name, def);
        else if (this.viewBases.has(name)) {
          const prev = this.viewBases.get(name)!;
          if (prev.file !== f) this.project.warnings.add(`View "${name}" defined in both ${prev.file.relPath} and ${f.relPath}; using the first`);
        } else this.viewBases.set(name, def);
      } else {
        if (isRef) push(this.exploreRefinements, name, def);
        else if (!this.exploreBases.has(name)) this.exploreBases.set(name, def);
      }
    }
  }

  exploreNames(): string[] {
    return [...this.exploreBases.keys()];
  }

  exploreFile(name: string): LkmlFile | undefined {
    return this.exploreBases.get(name)?.file;
  }

  hasView(name: string): boolean {
    return this.viewBases.has(name) || this.viewRefinements.has(name);
  }

  getView(name: string, stack: string[] = []): ResolvedView | undefined {
    if (this.viewCache.has(name)) return this.viewCache.get(name) ?? undefined;
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
    let own: Entry[] = base ? base.entries : [];
    for (const r of refs) own = mergeEntries(own, r.entries);

    let merged: Entry[] = [];
    let partial = !base;
    for (const parent of getList(own, 'extends') ?? []) {
      const pv = this.getView(parent, [...stack, name]);
      if (!pv) {
        this.project.warnings.add(`View "${name}" extends unknown view "${parent}" (is its project mapped in lookmlDoc.remoteProjects?)`);
        partial = true;
        continue;
      }
      if (pv.partial) partial = true;
      merged = mergeEntries(merged, pv.entries.filter((e) => e.key !== 'extends' && e.key !== 'extension'));
    }
    merged = mergeEntries(merged, own);

    const fields = new Map<string, FieldDef>();
    const sets = new Map<string, string[]>();
    for (const e of merged) {
      if (isFieldKind(e.key) && e.name && e.value.kind === 'block') {
        fields.set(e.name, { kind: e.key, name: e.name, entries: e.value.entries });
      } else if (e.key === 'set' && e.name && e.value.kind === 'block') {
        sets.set(e.name, getList(e.value.entries, 'fields') ?? []);
      }
    }
    const view: ResolvedView = { name, entries: merged, fields, sets, partial };
    this.viewCache.set(name, view);
    return view;
  }

  getExplore(name: string, stack: string[] = []): ResolvedExplore | undefined {
    if (this.exploreCache.has(name)) return this.exploreCache.get(name) ?? undefined;
    const base = this.exploreBases.get(name);
    if (!base || stack.includes(name)) return undefined;
    let own = base.entries;
    for (const r of this.exploreRefinements.get(name) ?? []) own = mergeEntries(own, r.entries);
    let merged: Entry[] = [];
    for (const parent of getList(own, 'extends') ?? []) {
      const pe = this.getExplore(parent, [...stack, name]);
      if (pe) merged = mergeEntries(merged, pe.entries.filter((e) => e.key !== 'extends' && e.key !== 'extension'));
      else this.project.warnings.add(`Explore "${name}" extends unknown explore "${parent}"`);
    }
    merged = mergeEntries(merged, own);

    const baseAlias = getText(merged, 'view_name') ?? name;
    const baseView = getText(merged, 'from') ?? getText(merged, 'view_name') ?? name;
    const aliases: ExploreAlias[] = [{ alias: baseAlias, viewName: baseView, isBase: true }];
    for (const e of merged) {
      if (e.key !== 'join' || !e.name || e.value.kind !== 'block') continue;
      const j = e.value.entries;
      aliases.push({ alias: e.name, viewName: getText(j, 'from') ?? getText(j, 'view_name') ?? e.name, isBase: false, join: j });
    }
    const explore: ResolvedExplore = { name, entries: merged, aliases, file: base.file };
    this.exploreCache.set(name, explore);
    return explore;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export { getBlock };
