import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { Entry, getText, parseLookml } from './parser';

/** A parsed .lkml file, identified by project + posix path relative to that project root ("/a/b.view.lkml"). */
export interface LkmlFile {
  project: string;
  relPath: string;
  absPath: string;
  entries: Entry[];
}

export interface ProjectOptions {
  /** Root folder of the main (local) project. */
  root: string;
  /** Remote/local dependency name -> folder, used for `//name/...` includes. */
  remoteProjects?: Record<string, string>;
}

export const MAIN = '';

export class Warnings {
  private readonly set = new Set<string>();
  add(msg: string): void {
    this.set.add(msg);
  }
  list(): string[] {
    return [...this.set];
  }
}

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.lkml')) out.push(p);
  }
}

/**
 * Loads LookML files lazily, resolves `include:` statements (globs, `//project/` prefixes)
 * and exposes manifest constants.
 */
export class LookmlProject {
  readonly warnings = new Warnings();
  private readonly roots = new Map<string, string>();
  /** Remote names that point at the main project folder itself (e.g. `//one-crm-spoke/`). */
  private readonly selfAliases = new Set<string>();
  private readonly fileLists = new Map<string, string[]>(); // project -> relPaths
  private readonly cache = new Map<string, LkmlFile | null>();
  readonly constants = new Map<string, string>();

  constructor(opts: ProjectOptions) {
    this.roots.set(MAIN, path.resolve(opts.root));
    const mainRoot = path.resolve(opts.root).toLowerCase();
    for (const [name, dir] of Object.entries(opts.remoteProjects ?? {})) {
      if (!dir) continue;
      if (path.resolve(dir).toLowerCase() === mainRoot) this.selfAliases.add(name);
      else this.roots.set(name, path.resolve(dir));
    }
    // dependencies declared in the main manifest; any other `//name/` is taken as this project itself
    this.declaredDeps = new Set(
      (this.getFile(MAIN, '/manifest.lkml')?.entries ?? [])
        .filter((e) => (e.key === 'remote_dependency' || e.key === 'local_dependency') && e.name)
        .map((e) => e.name!),
    );
    this.loadConstants();
  }

  private readonly declaredDeps: Set<string>;

  get root(): string {
    return this.roots.get(MAIN)!;
  }

  private loadConstants(): void {
    // remote manifests first so the main project's values win
    const order = [...this.roots.keys()].filter((p) => p !== MAIN).concat(MAIN);
    for (const proj of order) {
      const f = this.getFile(proj, '/manifest.lkml');
      if (!f) continue;
      for (const e of f.entries) {
        if (e.key === 'constant' && e.name && e.value.kind === 'block') {
          const v = getText(e.value.entries, 'value');
          if (v !== undefined) this.constants.set(e.name, v);
        }
        if (e.key === 'override_constant' && e.name && e.value.kind === 'block') {
          const v = getText(e.value.entries, 'value');
          if (v !== undefined) this.constants.set(e.name, v);
        }
      }
    }
  }

  /** Replace `@{constant}` references. Unknown constants are left untouched. */
  applyConstants(text: string): string {
    return text.replace(/@\{\s*(\w+)\s*\}/g, (m, name: string) =>
      this.constants.has(name) ? this.constants.get(name)! : m);
  }

  listFiles(project: string): string[] {
    let list = this.fileLists.get(project);
    if (!list) {
      const root = this.roots.get(project);
      const abs: string[] = [];
      if (root) walk(root, abs);
      list = abs.map((p) => '/' + path.relative(root!, p).split(path.sep).join('/')).sort();
      this.fileLists.set(project, list);
    }
    return list;
  }

  getFile(project: string, relPath: string): LkmlFile | undefined {
    const key = `${project}::${relPath}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;
    const root = this.roots.get(project);
    let result: LkmlFile | null = null;
    if (root) {
      const absPath = path.join(root, ...relPath.split('/').filter(Boolean));
      if (fs.existsSync(absPath)) {
        try {
          const text = fs.readFileSync(absPath, 'utf8');
          result = { project, relPath, absPath, entries: parseLookml(text) };
        } catch (err) {
          this.warnings.add(`Parse error in ${absPath}: ${(err as Error).message}`);
        }
      }
    }
    this.cache.set(key, result);
    return result ?? undefined;
  }

  /** Find the file object for an absolute path inside the main project. */
  fileFromAbsPath(absPath: string): LkmlFile | undefined {
    for (const [proj, root] of this.roots) {
      const rel = path.relative(root, absPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return this.getFile(proj, '/' + rel.split(path.sep).join('/'));
      }
    }
    return undefined;
  }

  /** Resolve one include pattern relative to the including file. */
  resolveInclude(pattern: string, from: LkmlFile): LkmlFile[] {
    let project = from.project;
    let pat = pattern.trim();
    const remote = /^\/\/([^/]+)(\/.*)$/.exec(pat);
    if (remote) {
      const isSelf = this.selfAliases.has(remote[1]) || (!this.roots.has(remote[1]) && !this.declaredDeps.has(remote[1]));
      project = isSelf ? MAIN : remote[1];
      pat = remote[2];
      if (!this.roots.has(project)) {
        this.warnings.add(`Remote project "${project}" is not mapped to a local folder (setting lookmlDoc.remoteProjects) - include "${pattern}" skipped`);
        return [];
      }
    } else if (!pat.startsWith('/')) {
      const dir = path.posix.dirname(from.relPath);
      pat = path.posix.normalize(path.posix.join(dir, pat));
    }
    if (!/\.(lkml|lookml)$/.test(pat) && !pat.endsWith('*')) pat += '.lkml';

    const files = this.listFiles(project).filter((f) => minimatch(f, pat, { dot: true }));
    if (files.length === 0 && !/\.lookml$/.test(pat)) {
      this.warnings.add(`Include "${pattern}" (from ${from.relPath}) matched no files`);
    }
    return files.map((f) => this.getFile(project, f)).filter((f): f is LkmlFile => !!f);
  }

  /** All files reachable from `start` through include statements, in include order (start first). */
  reachableFiles(start: LkmlFile): LkmlFile[] {
    const seen = new Set<string>();
    const out: LkmlFile[] = [];
    const visit = (f: LkmlFile) => {
      const key = `${f.project}::${f.relPath}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(f);
      for (const e of f.entries) {
        if (e.key !== 'include') continue;
        const pats = e.value.kind === 'scalar' ? [e.value.text]
          : e.value.kind === 'list' ? e.value.items.filter((i) => i.kind === 'scalar').map((i) => (i as { text: string }).text)
          : [];
        for (const p of pats) for (const inc of this.resolveInclude(p, f)) visit(inc);
      }
    };
    visit(start);
    return out;
  }

  modelFiles(): LkmlFile[] {
    return this.listFiles(MAIN)
      .filter((f) => f.endsWith('.model.lkml'))
      .map((f) => this.getFile(MAIN, f))
      .filter((f): f is LkmlFile => !!f);
  }
}
