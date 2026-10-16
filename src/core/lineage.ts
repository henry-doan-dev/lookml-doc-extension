import { Entry, getBlock, getEntry, getList, getText } from './parser';
import { FieldDef, LookmlModel, ResolvedExplore, ResolvedView } from './model';
import { hasLiquid, stripLiquid } from './liquid';
import { columnRefs, isDirectColumn, parseQuery, Query, queryHasColumn, Source, VIEW_PLACEHOLDER } from './sql';

export interface MartSource {
  table: string;
  column: string;
}

export interface Transform {
  /** Empty for the documented field itself, otherwise `view.field` or `view (derived_table)`. */
  where: string;
  text: string;
}

export interface Lineage {
  sources: MartSource[];
  transforms: Transform[];
}

/** Which concrete field of a view a field id points at (handles dimension_group timeframes). */
export interface FieldRef {
  def: FieldDef;
  timeframe?: string;
  interval?: string;
}

const AGG_SQL: Record<string, (s: string) => string> = {
  sum: (s) => `SUM(${s})`,
  sum_distinct: (s) => `SUM(DISTINCT ${s})`,
  average: (s) => `AVG(${s})`,
  average_distinct: (s) => `AVG(DISTINCT ${s})`,
  count: (s) => `COUNT(${s})`,
  count_distinct: (s) => `COUNT(DISTINCT ${s})`,
  min: (s) => `MIN(${s})`,
  max: (s) => `MAX(${s})`,
  median: (s) => `MEDIAN(${s})`,
  median_distinct: (s) => `MEDIAN(DISTINCT ${s})`,
  list: (s) => `LIST(${s})`,
};

/** Remove common indentation and trailing spaces; keeps line breaks. */
export function tidy(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return '';
  const indents = lines.slice(1).filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return [lines[0].trim(), ...lines.slice(1).map((l) => l.slice(cut))].join('\n').trim();
}

export function lookupField(view: ResolvedView, fieldId: string): FieldRef | undefined {
  const direct = view.fields.get(fieldId);
  if (direct) return { def: direct };
  for (const def of view.fields.values()) {
    if (def.kind !== 'dimension_group') continue;
    const type = (getText(def.entries, 'type') ?? 'time').toLowerCase();
    if (type === 'duration') {
      const m = new RegExp(`^(\\w+?)s_${def.name}$`).exec(fieldId);
      if (m) return { def, interval: m[1] };
    } else if (fieldId.startsWith(def.name + '_')) {
      return { def, timeframe: fieldId.slice(def.name.length + 1) };
    }
  }
  return undefined;
}

/** The SQL text(s) Looker would use for a field, including LookML defaults. */
function fieldSql(ref: FieldRef): string[] {
  const { def } = ref;
  if (def.kind === 'dimension_group' && (getText(def.entries, 'type') ?? '').toLowerCase() === 'duration') {
    return [getText(def.entries, 'sql_start'), getText(def.entries, 'sql_end')].filter((s): s is string => !!s);
  }
  const sql = getText(def.entries, 'sql');
  if (sql !== undefined) return [sql];
  const type = (getText(def.entries, 'type') ?? '').toLowerCase();
  if (type === 'location') {
    return [getText(def.entries, 'sql_latitude'), getText(def.entries, 'sql_longitude')].filter((s): s is string => !!s);
  }
  const caseSql = caseToSql(def.entries);
  if (caseSql) return [caseSql];
  if (def.kind === 'dimension' || def.kind === 'dimension_group') return [`\${TABLE}.${def.name}`];
  return [];
}

/** Render a LookML `case: { when: { sql: ... label: "..." } else: "..." }` as SQL. */
function caseToSql(entries: Entry[]): string | undefined {
  const block = getBlock(entries, 'case');
  if (!block) return undefined;
  const whens = block
    .filter((e) => e.key === 'when' && e.value.kind === 'block')
    .map((e) => {
      const w = (e.value as { entries: Entry[] }).entries;
      const cond = tidy(getText(w, 'sql') ?? '').replace(/\n/g, '\n       ');
      return `  WHEN ${cond}\n    THEN '${getText(w, 'label') ?? ''}'`;
    });
  if (!whens.length) return undefined;
  const els = getText(block, 'else');
  return ['CASE', ...whens, ...(els !== undefined ? [`  ELSE '${els}'`] : []), 'END'].join('\n');
}

/** `${TABLE}.col`, `${field}` or `${view.field}` with nothing else around it. */
export function isPassthrough(sql: string): boolean {
  return !hasLiquid(sql) && /^\$\{[^}]+\}(\.\w+)?$/.test(sql.trim());
}

const REF_RE = /\$\{\s*([\w.]+)\s*\}(?:\.(\w+))?/g;

export class LineageResolver {
  private readonly queryCache = new Map<string, { query: Query; where: string } | null>();

  constructor(
    private readonly model: LookmlModel,
    private readonly explore: ResolvedExplore | undefined,
    private warn: (msg: string) => void,
  ) {}

  /** Map an `${alias.field}` qualifier to a view name. */
  private viewForQualifier(q: string): string | undefined {
    const a = this.explore?.aliases.find((x) => x.alias === q);
    if (a) return a.viewName;
    return this.model.hasView(q) ? q : undefined;
  }

  resolve(viewName: string, ref: FieldRef, fieldId: string): Lineage {
    const out: Lineage = { sources: [], transforms: [] };
    this.walkField(viewName, ref, fieldId, out, new Set(), 0);
    return dedupe(out);
  }

  private walkField(viewName: string, ref: FieldRef, fieldId: string, out: Lineage, seen: Set<string>, depth: number): void {
    const key = `f:${viewName}.${fieldId}`;
    if (seen.has(key) || depth > 40) return;
    seen.add(key);

    const sqls = fieldSql(ref);
    const where = depth === 0 ? '' : `${viewName}.${fieldId}`;
    const type = (getText(ref.def.entries, 'type') ?? '').toLowerCase();

    // business logic at this level
    const isDuration = ref.interval !== undefined;
    const transformed = isDuration || sqls.some((s) => !isPassthrough(s));
    const filters = ref.def.kind === 'measure' ? getList(ref.def.entries, 'filters') : undefined;
    if (transformed || (filters && filters.length)) {
      let text = isDuration
        ? `${ref.interval}s between ${tidy(sqls[0] ?? '')} and ${tidy(sqls[1] ?? '')}`
        : sqls.map(tidy).join('\n');
      if (transformed && ref.def.kind === 'measure' && AGG_SQL[type] && text) text = AGG_SQL[type](text);
      if (!transformed) text = '';
      if (filters && filters.length) text = [text, `filters: [${filters.join(', ')}]`].filter(Boolean).join('\n');
      out.transforms.push({ where, text });
    }

    for (const sql of sqls) {
      const clean = this.model.project.applyConstants(stripLiquid(sql));
      for (const m of clean.matchAll(REF_RE)) {
        const inner = m[1];
        const suffix = m[2];
        if (inner === 'TABLE') {
          if (suffix) this.walkColumn(viewName, suffix, out, seen, depth + 1);
          continue;
        }
        const parts = inner.split('.');
        if (parts.length === 1) {
          this.walkFieldId(viewName, parts[0], out, seen, depth + 1, `${viewName}.${fieldId}`);
        } else {
          const [q, f] = parts;
          if (f === 'SQL_TABLE_NAME' || f.startsWith('_')) continue;
          const target = this.viewForQualifier(q);
          if (!target) {
            this.warn(`${viewName}.${fieldId}: cannot resolve \${${inner}} (unknown view/alias "${q}")`);
            continue;
          }
          this.walkFieldId(target, f, out, seen, depth + 1, `${viewName}.${fieldId}`);
        }
      }
    }
  }

  private walkFieldId(viewName: string, fieldId: string, out: Lineage, seen: Set<string>, depth: number, from: string): void {
    const view = this.model.getView(viewName);
    if (!view) {
      this.warn(`${from}: view "${viewName}" not found`);
      return;
    }
    const ref = lookupField(view, fieldId);
    if (!ref) {
      this.warn(`${from}: field ${viewName}.${fieldId} not found`);
      return;
    }
    this.walkField(viewName, ref, fieldId, out, seen, depth);
  }

  private walkColumn(viewName: string, column: string, out: Lineage, seen: Set<string>, depth: number): void {
    const key = `c:${viewName}.${column.toLowerCase()}`;
    if (seen.has(key) || depth > 40) return;
    seen.add(key);

    const view = this.model.getView(viewName);
    if (!view) {
      this.warn(`View "${viewName}" not found while resolving column ${column}`);
      return;
    }
    const dt = getBlock(view.entries, 'derived_table');
    if (dt) {
      const exploreSource = getEntry(dt, 'explore_source');
      if (exploreSource && exploreSource.value.kind === 'block') {
        this.walkNdtColumn(viewName, exploreSource, column, out, seen, depth);
        return;
      }
    }
    const vq = this.viewQuery(view);
    if (vq) {
      this.walkQueryColumn(vq.query, column, vq.where, out, seen, depth);
      return;
    }
    const tableText = getText(view.entries, 'sql_table_name');
    if (tableText) {
      const t = this.model.project.applyConstants(tableText).replace(/`/g, '').trim();
      const viewRef = /\$\{\s*(\w+)\.SQL_TABLE_NAME\s*\}/.exec(t);
      if (viewRef) this.walkColumn(viewRef[1], column, out, seen, depth + 1);
      else out.sources.push({ table: t, column });
      return;
    }
    if (view.partial) {
      this.warn(`View "${viewName}": base definition not available, column ${column} cannot be traced`);
      return;
    }
    // LookML default: sql_table_name = view name
    out.sources.push({ table: viewName, column });
  }

  /** true = the view's SQL exposes the column, false = it definitely does not, undefined = unknown (physical table). */
  private viewHasColumn(viewName: string, column: string): boolean | undefined {
    const view = this.model.getView(viewName);
    const vq = view && this.viewQuery(view);
    if (!vq) return undefined;
    if (vq.query.items.some((i) => i.alias?.toLowerCase() === column.toLowerCase())) return true;
    return queryHasColumn(vq.query, column) ? undefined : false;
  }

  /**
   * The SELECT behind a view: `derived_table: { sql }`, or a sub-query written directly in
   * `sql_table_name: ( SELECT ... )`.
   */
  private viewQuery(view: ResolvedView): { query: Query; where: string } | undefined {
    if (this.queryCache.has(view.name)) {
      const cached = this.queryCache.get(view.name);
      return cached ?? undefined;
    }
    let result: { query: Query; where: string } | null = null;
    const dt = getBlock(view.entries, 'derived_table');
    const dtSql = dt && !getEntry(dt, 'explore_source') ? getText(dt, 'sql') : undefined;
    const tableText = getText(view.entries, 'sql_table_name');
    const [sql, where] = dtSql
      ? [dtSql, `${view.name} (derived_table)`]
      : tableText && /\bselect\b/i.test(tableText) ? [tableText, `${view.name} (sql_table_name)`] : [undefined, ''];
    if (sql) {
      const prepared = this.model.project.applyConstants(stripLiquid(sql))
        .replace(/\$\{\s*(\w+)\.SQL_TABLE_NAME\s*\}/g, (_m, v: string) => `${VIEW_PLACEHOLDER}${v}`)
        .replace(/\$\{[^}]*\}/g, 'NULL');
      try {
        result = { query: parseQuery(prepared), where };
      } catch (err) {
        this.warn(`View "${view.name}": could not parse SQL (${(err as Error).message})`);
      }
    }
    this.queryCache.set(view.name, result);
    return result ?? undefined;
  }

  private walkQueryColumn(q: Query, column: string, where: string, out: Lineage, seen: Set<string>, depth: number): void {
    const idx = q.items.findIndex((i) => i.alias?.toLowerCase() === column.toLowerCase());
    if (idx < 0) {
      const stars = q.items.filter((i) => i.star);
      if (!stars.length) {
        this.warn(`${where}: column "${column}" not found in SELECT list`);
        return;
      }
      const srcs = stars.flatMap((s) => s.star === true
        ? [...q.sources.values()].filter((x) => x.kind !== 'unnest')
        : [q.sources.get((s.star as string).toLowerCase())].filter((x): x is Source => !!x));
      // prefer sub-queries that really expose the column; physical tables/views are opaque
      const known = srcs.filter((x) =>
        (x.kind === 'query' && queryHasColumn(x.query, column)) || (x.kind === 'view' && this.viewHasColumn(x.name, column) === true));
      const targets = known.length ? known : srcs.filter((x) => x.kind === 'table' || (x.kind === 'view' && this.viewHasColumn(x.name, column) !== false));
      if (targets.length === 1) {
        this.walkSource(targets[0], column, where, out, seen, depth + 1);
        return;
      }
      // several opaque candidates (`SELECT *` over a join): keep only the ones that actually resolve
      let found = false;
      for (const src of targets) {
        const tmp: Lineage = { sources: [], transforms: [] };
        const buffered: string[] = [];
        const saved = this.warn;
        this.warn = (m) => buffered.push(m);
        try {
          this.walkSource(src, column, where, tmp, seen, depth + 1);
        } finally {
          this.warn = saved;
        }
        if (tmp.sources.length || tmp.transforms.length) {
          found = true;
          out.sources.push(...tmp.sources);
          out.transforms.push(...tmp.transforms);
          buffered.forEach((m) => this.warn(m));
        }
      }
      if (!found) this.warn(`${where}: column "${column}" not found in SELECT list`);
      return;
    }
    const branches = [q, ...q.unions];
    for (const b of branches) {
      const item = b.items[idx];
      if (item) this.walkExpr(b, item.expr, item.alias ?? column, where, out, seen, depth);
    }
  }

  private walkExpr(q: Query, expr: string, alias: string, where: string, out: Lineage, seen: Set<string>, depth: number): void {
    if (!isDirectColumn(expr)) out.transforms.push({ where, text: `${tidy(expr)} AS ${alias}` });
    const refs = columnRefs(expr);
    const qualified = refs.filter((r) => r.qualifier && q.sources.has(r.qualifier));
    for (const r of qualified) this.walkSource(q.sources.get(r.qualifier!)!, r.column, where, out, seen, depth + 1);
    if (qualified.length) return;

    const candidates = [...q.sources.values()].filter((s) => s.kind !== 'unnest');
    for (const r of refs.filter((x) => !x.qualifier)) {
      if (q.sources.has(r.column.toLowerCase())) continue; // unnest alias / whole-row reference
      if (candidates.length === 1) {
        this.walkSource(candidates[0], r.column, where, out, seen, depth + 1);
        continue;
      }
      const col = r.column.toLowerCase();
      // sources whose SELECT list is known to contain the column
      const definite = candidates.filter((s) =>
        (s.kind === 'query' && s.query.items.some((i) => i.alias?.toLowerCase() === col)) ||
        (s.kind === 'view' && this.viewHasColumn(s.name, r.column) === true));
      // sources that may contain it (physical tables are opaque)
      const possible = candidates.filter((s) =>
        s.kind === 'table' || s.kind === 'pivot' ||
        (s.kind === 'query' && queryHasColumn(s.query, r.column)) ||
        (s.kind === 'view' && this.viewHasColumn(s.name, r.column) !== false));
      const pick = definite.length === 1 ? definite[0] : possible.length === 1 ? possible[0] : undefined;
      if (pick) this.walkSource(pick, r.column, where, out, seen, depth + 1);
      else if (candidates.length > 1) this.warn(`${where}: unqualified column "${r.column}" is ambiguous`);
    }
  }

  private walkSource(src: Source, column: string, where: string, out: Lineage, seen: Set<string>, depth: number): void {
    if (src.kind === 'table') out.sources.push({ table: src.name, column });
    else if (src.kind === 'view') this.walkColumn(src.name, column, out, seen, depth);
    else if (src.kind === 'query') this.walkQueryColumn(src.query, column, where, out, seen, depth);
    else if (src.kind === 'pivot') this.walkPivot(src, column, where, out, seen, depth);
  }

  /** PIVOT output columns are named `<agg alias>_<value alias>`; other columns pass through. */
  private walkPivot(src: Extract<Source, { kind: 'pivot' }>, column: string, where: string, out: Lineage, seen: Set<string>, depth: number): void {
    const c = column.toLowerCase();
    const agg = src.aggs.find((a) => a.alias && c.startsWith(a.alias.toLowerCase() + '_'))
      ?? (src.aggs.length === 1 && !src.aggs[0].alias ? src.aggs[0] : undefined);
    if (!agg) {
      this.walkSource(src.inner, column, where, out, seen, depth + 1);
      return;
    }
    out.transforms.push({ where, text: `PIVOT ${tidy(agg.expr)} -> ${column}` });
    for (const r of columnRefs(agg.expr)) this.walkSource(src.inner, r.column, where, out, seen, depth + 1);
  }

  /** Native derived table: `column: x { field: alias.field }` -> resolve inside the source explore. */
  private walkNdtColumn(viewName: string, es: Entry, column: string, out: Lineage, seen: Set<string>, depth: number): void {
    const entries = (es.value as { entries: Entry[] }).entries;
    const col = entries.find((e) => (e.key === 'column' || e.key === 'derived_column') && e.name?.toLowerCase() === column.toLowerCase());
    if (!col || col.value.kind !== 'block') {
      this.warn(`${viewName} (explore_source ${es.name}): column "${column}" not found`);
      return;
    }
    if (col.key === 'derived_column') {
      const sql = getText(col.value.entries, 'sql') ?? '';
      out.transforms.push({ where: `${viewName} (explore_source)`, text: `${tidy(sql)} AS ${column}` });
      for (const r of columnRefs(stripLiquid(sql))) {
        if (!r.qualifier && r.column.toLowerCase() !== column.toLowerCase()) this.walkColumn(viewName, r.column, out, seen, depth + 1);
      }
      return;
    }
    const field = getText(col.value.entries, 'field') ?? column;
    const srcExplore = es.name ? this.model.getExplore(es.name) : undefined;
    if (!srcExplore) {
      this.warn(`${viewName}: explore_source "${es.name}" not found`);
      return;
    }
    const [alias, fieldId] = field.includes('.') ? field.split('.') : [srcExplore.aliases[0].alias, field];
    const target = srcExplore.aliases.find((a) => a.alias === alias)?.viewName ?? alias;
    const sub = new LineageResolver(this.model, srcExplore, this.warn);
    const view = this.model.getView(target);
    const ref = view && lookupField(view, fieldId);
    if (!ref) {
      this.warn(`${viewName}: explore_source field ${field} not found`);
      return;
    }
    const subOut = sub.resolve(target, ref, fieldId);
    out.sources.push(...subOut.sources);
    out.transforms.push(...subOut.transforms.map((t) => ({ where: t.where || `${target}.${fieldId}`, text: t.text })));
  }
}

function dedupe(l: Lineage): Lineage {
  const s = new Map<string, MartSource>();
  for (const x of l.sources) s.set(`${x.table.toLowerCase()}|${x.column.toLowerCase()}`, x);
  const t = new Map<string, Transform>();
  for (const x of l.transforms) t.set(`${x.where}|${x.text}`, x);
  return { sources: [...s.values()], transforms: [...t.values()] };
}
