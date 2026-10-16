"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LineageResolver = void 0;
exports.tidy = tidy;
exports.lookupField = lookupField;
exports.isPassthrough = isPassthrough;
const parser_1 = require("./parser");
const liquid_1 = require("./liquid");
const sql_1 = require("./sql");
const AGG_SQL = {
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
function tidy(text) {
    const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length && !lines[lines.length - 1].trim())
        lines.pop();
    if (!lines.length)
        return '';
    const indents = lines.slice(1).filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return [lines[0].trim(), ...lines.slice(1).map((l) => l.slice(cut))].join('\n').trim();
}
function lookupField(view, fieldId) {
    const direct = view.fields.get(fieldId);
    if (direct)
        return { def: direct };
    for (const def of view.fields.values()) {
        if (def.kind !== 'dimension_group')
            continue;
        const type = ((0, parser_1.getText)(def.entries, 'type') ?? 'time').toLowerCase();
        if (type === 'duration') {
            const m = new RegExp(`^(\\w+?)s_${def.name}$`).exec(fieldId);
            if (m)
                return { def, interval: m[1] };
        }
        else if (fieldId.startsWith(def.name + '_')) {
            return { def, timeframe: fieldId.slice(def.name.length + 1) };
        }
    }
    return undefined;
}
/** The SQL text(s) Looker would use for a field, including LookML defaults. */
function fieldSql(ref) {
    const { def } = ref;
    if (def.kind === 'dimension_group' && ((0, parser_1.getText)(def.entries, 'type') ?? '').toLowerCase() === 'duration') {
        return [(0, parser_1.getText)(def.entries, 'sql_start'), (0, parser_1.getText)(def.entries, 'sql_end')].filter((s) => !!s);
    }
    const sql = (0, parser_1.getText)(def.entries, 'sql');
    if (sql !== undefined)
        return [sql];
    const type = ((0, parser_1.getText)(def.entries, 'type') ?? '').toLowerCase();
    if (type === 'location') {
        return [(0, parser_1.getText)(def.entries, 'sql_latitude'), (0, parser_1.getText)(def.entries, 'sql_longitude')].filter((s) => !!s);
    }
    const caseSql = caseToSql(def.entries);
    if (caseSql)
        return [caseSql];
    if (def.kind === 'dimension' || def.kind === 'dimension_group')
        return [`\${TABLE}.${def.name}`];
    return [];
}
/** Render a LookML `case: { when: { sql: ... label: "..." } else: "..." }` as SQL. */
function caseToSql(entries) {
    const block = (0, parser_1.getBlock)(entries, 'case');
    if (!block)
        return undefined;
    const whens = block
        .filter((e) => e.key === 'when' && e.value.kind === 'block')
        .map((e) => {
        const w = e.value.entries;
        const cond = tidy((0, parser_1.getText)(w, 'sql') ?? '').replace(/\n/g, '\n       ');
        return `  WHEN ${cond}\n    THEN '${(0, parser_1.getText)(w, 'label') ?? ''}'`;
    });
    if (!whens.length)
        return undefined;
    const els = (0, parser_1.getText)(block, 'else');
    return ['CASE', ...whens, ...(els !== undefined ? [`  ELSE '${els}'`] : []), 'END'].join('\n');
}
/** `${TABLE}.col`, `${field}` or `${view.field}` with nothing else around it. */
function isPassthrough(sql) {
    return !(0, liquid_1.hasLiquid)(sql) && /^\$\{[^}]+\}(\.\w+)?$/.test(sql.trim());
}
const REF_RE = /\$\{\s*([\w.]+)\s*\}(?:\.(\w+))?/g;
class LineageResolver {
    model;
    explore;
    warn;
    queryCache = new Map();
    constructor(model, explore, warn) {
        this.model = model;
        this.explore = explore;
        this.warn = warn;
    }
    /** Map an `${alias.field}` qualifier to a view name. */
    viewForQualifier(q) {
        const a = this.explore?.aliases.find((x) => x.alias === q);
        if (a)
            return a.viewName;
        return this.model.hasView(q) ? q : undefined;
    }
    resolve(viewName, ref, fieldId) {
        const out = { sources: [], transforms: [] };
        this.walkField(viewName, ref, fieldId, out, new Set(), 0);
        return dedupe(out);
    }
    walkField(viewName, ref, fieldId, out, seen, depth) {
        const key = `f:${viewName}.${fieldId}`;
        if (seen.has(key) || depth > 40)
            return;
        seen.add(key);
        const sqls = fieldSql(ref);
        const where = depth === 0 ? '' : `${viewName}.${fieldId}`;
        const type = ((0, parser_1.getText)(ref.def.entries, 'type') ?? '').toLowerCase();
        // business logic at this level
        const isDuration = ref.interval !== undefined;
        const transformed = isDuration || sqls.some((s) => !isPassthrough(s));
        const filters = ref.def.kind === 'measure' ? (0, parser_1.getList)(ref.def.entries, 'filters') : undefined;
        if (transformed || (filters && filters.length)) {
            let text = isDuration
                ? `${ref.interval}s between ${tidy(sqls[0] ?? '')} and ${tidy(sqls[1] ?? '')}`
                : sqls.map(tidy).join('\n');
            if (transformed && ref.def.kind === 'measure' && AGG_SQL[type] && text)
                text = AGG_SQL[type](text);
            if (!transformed)
                text = '';
            if (filters && filters.length)
                text = [text, `filters: [${filters.join(', ')}]`].filter(Boolean).join('\n');
            out.transforms.push({ where, text });
        }
        for (const sql of sqls) {
            const clean = this.model.project.applyConstants((0, liquid_1.stripLiquid)(sql));
            for (const m of clean.matchAll(REF_RE)) {
                const inner = m[1];
                const suffix = m[2];
                if (inner === 'TABLE') {
                    if (suffix)
                        this.walkColumn(viewName, suffix, out, seen, depth + 1);
                    continue;
                }
                const parts = inner.split('.');
                if (parts.length === 1) {
                    this.walkFieldId(viewName, parts[0], out, seen, depth + 1, `${viewName}.${fieldId}`);
                }
                else {
                    const [q, f] = parts;
                    if (f === 'SQL_TABLE_NAME' || f.startsWith('_'))
                        continue;
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
    walkFieldId(viewName, fieldId, out, seen, depth, from) {
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
    walkColumn(viewName, column, out, seen, depth) {
        const key = `c:${viewName}.${column.toLowerCase()}`;
        if (seen.has(key) || depth > 40)
            return;
        seen.add(key);
        const view = this.model.getView(viewName);
        if (!view) {
            this.warn(`View "${viewName}" not found while resolving column ${column}`);
            return;
        }
        const dt = (0, parser_1.getBlock)(view.entries, 'derived_table');
        if (dt) {
            const exploreSource = (0, parser_1.getEntry)(dt, 'explore_source');
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
        const tableText = (0, parser_1.getText)(view.entries, 'sql_table_name');
        if (tableText) {
            const t = this.model.project.applyConstants(tableText).replace(/`/g, '').trim();
            const viewRef = /\$\{\s*(\w+)\.SQL_TABLE_NAME\s*\}/.exec(t);
            if (viewRef)
                this.walkColumn(viewRef[1], column, out, seen, depth + 1);
            else
                out.sources.push({ table: t, column });
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
    viewHasColumn(viewName, column) {
        const view = this.model.getView(viewName);
        const vq = view && this.viewQuery(view);
        if (!vq)
            return undefined;
        if (vq.query.items.some((i) => i.alias?.toLowerCase() === column.toLowerCase()))
            return true;
        return (0, sql_1.queryHasColumn)(vq.query, column) ? undefined : false;
    }
    /**
     * The SELECT behind a view: `derived_table: { sql }`, or a sub-query written directly in
     * `sql_table_name: ( SELECT ... )`.
     */
    viewQuery(view) {
        if (this.queryCache.has(view.name)) {
            const cached = this.queryCache.get(view.name);
            return cached ?? undefined;
        }
        let result = null;
        const dt = (0, parser_1.getBlock)(view.entries, 'derived_table');
        const dtSql = dt && !(0, parser_1.getEntry)(dt, 'explore_source') ? (0, parser_1.getText)(dt, 'sql') : undefined;
        const tableText = (0, parser_1.getText)(view.entries, 'sql_table_name');
        const [sql, where] = dtSql
            ? [dtSql, `${view.name} (derived_table)`]
            : tableText && /\bselect\b/i.test(tableText) ? [tableText, `${view.name} (sql_table_name)`] : [undefined, ''];
        if (sql) {
            const prepared = this.model.project.applyConstants((0, liquid_1.stripLiquid)(sql))
                .replace(/\$\{\s*(\w+)\.SQL_TABLE_NAME\s*\}/g, (_m, v) => `${sql_1.VIEW_PLACEHOLDER}${v}`)
                .replace(/\$\{[^}]*\}/g, 'NULL');
            try {
                result = { query: (0, sql_1.parseQuery)(prepared), where };
            }
            catch (err) {
                this.warn(`View "${view.name}": could not parse SQL (${err.message})`);
            }
        }
        this.queryCache.set(view.name, result);
        return result ?? undefined;
    }
    walkQueryColumn(q, column, where, out, seen, depth) {
        const idx = q.items.findIndex((i) => i.alias?.toLowerCase() === column.toLowerCase());
        if (idx < 0) {
            const stars = q.items.filter((i) => i.star);
            if (!stars.length) {
                this.warn(`${where}: column "${column}" not found in SELECT list`);
                return;
            }
            const srcs = stars.flatMap((s) => s.star === true
                ? [...q.sources.values()].filter((x) => x.kind !== 'unnest')
                : [q.sources.get(s.star.toLowerCase())].filter((x) => !!x));
            // prefer sub-queries that really expose the column; physical tables/views are opaque
            const known = srcs.filter((x) => (x.kind === 'query' && (0, sql_1.queryHasColumn)(x.query, column)) || (x.kind === 'view' && this.viewHasColumn(x.name, column) === true));
            const targets = known.length ? known : srcs.filter((x) => x.kind === 'table' || (x.kind === 'view' && this.viewHasColumn(x.name, column) !== false));
            if (targets.length === 1) {
                this.walkSource(targets[0], column, where, out, seen, depth + 1);
                return;
            }
            // several opaque candidates (`SELECT *` over a join): keep only the ones that actually resolve
            let found = false;
            for (const src of targets) {
                const tmp = { sources: [], transforms: [] };
                const buffered = [];
                const saved = this.warn;
                this.warn = (m) => buffered.push(m);
                try {
                    this.walkSource(src, column, where, tmp, seen, depth + 1);
                }
                finally {
                    this.warn = saved;
                }
                if (tmp.sources.length || tmp.transforms.length) {
                    found = true;
                    out.sources.push(...tmp.sources);
                    out.transforms.push(...tmp.transforms);
                    buffered.forEach((m) => this.warn(m));
                }
            }
            if (!found)
                this.warn(`${where}: column "${column}" not found in SELECT list`);
            return;
        }
        const branches = [q, ...q.unions];
        for (const b of branches) {
            const item = b.items[idx];
            if (item)
                this.walkExpr(b, item.expr, item.alias ?? column, where, out, seen, depth);
        }
    }
    walkExpr(q, expr, alias, where, out, seen, depth) {
        if (!(0, sql_1.isDirectColumn)(expr))
            out.transforms.push({ where, text: `${tidy(expr)} AS ${alias}` });
        const refs = (0, sql_1.columnRefs)(expr);
        const qualified = refs.filter((r) => r.qualifier && q.sources.has(r.qualifier));
        for (const r of qualified)
            this.walkSource(q.sources.get(r.qualifier), r.column, where, out, seen, depth + 1);
        if (qualified.length)
            return;
        const candidates = [...q.sources.values()].filter((s) => s.kind !== 'unnest');
        for (const r of refs.filter((x) => !x.qualifier)) {
            if (q.sources.has(r.column.toLowerCase()))
                continue; // unnest alias / whole-row reference
            if (candidates.length === 1) {
                this.walkSource(candidates[0], r.column, where, out, seen, depth + 1);
                continue;
            }
            const col = r.column.toLowerCase();
            // sources whose SELECT list is known to contain the column
            const definite = candidates.filter((s) => (s.kind === 'query' && s.query.items.some((i) => i.alias?.toLowerCase() === col)) ||
                (s.kind === 'view' && this.viewHasColumn(s.name, r.column) === true));
            // sources that may contain it (physical tables are opaque)
            const possible = candidates.filter((s) => s.kind === 'table' || s.kind === 'pivot' ||
                (s.kind === 'query' && (0, sql_1.queryHasColumn)(s.query, r.column)) ||
                (s.kind === 'view' && this.viewHasColumn(s.name, r.column) !== false));
            const pick = definite.length === 1 ? definite[0] : possible.length === 1 ? possible[0] : undefined;
            if (pick)
                this.walkSource(pick, r.column, where, out, seen, depth + 1);
            else if (candidates.length > 1)
                this.warn(`${where}: unqualified column "${r.column}" is ambiguous`);
        }
    }
    walkSource(src, column, where, out, seen, depth) {
        if (src.kind === 'table')
            out.sources.push({ table: src.name, column });
        else if (src.kind === 'view')
            this.walkColumn(src.name, column, out, seen, depth);
        else if (src.kind === 'query')
            this.walkQueryColumn(src.query, column, where, out, seen, depth);
        else if (src.kind === 'pivot')
            this.walkPivot(src, column, where, out, seen, depth);
    }
    /** PIVOT output columns are named `<agg alias>_<value alias>`; other columns pass through. */
    walkPivot(src, column, where, out, seen, depth) {
        const c = column.toLowerCase();
        const agg = src.aggs.find((a) => a.alias && c.startsWith(a.alias.toLowerCase() + '_'))
            ?? (src.aggs.length === 1 && !src.aggs[0].alias ? src.aggs[0] : undefined);
        if (!agg) {
            this.walkSource(src.inner, column, where, out, seen, depth + 1);
            return;
        }
        out.transforms.push({ where, text: `PIVOT ${tidy(agg.expr)} -> ${column}` });
        for (const r of (0, sql_1.columnRefs)(agg.expr))
            this.walkSource(src.inner, r.column, where, out, seen, depth + 1);
    }
    /** Native derived table: `column: x { field: alias.field }` -> resolve inside the source explore. */
    walkNdtColumn(viewName, es, column, out, seen, depth) {
        const entries = es.value.entries;
        const col = entries.find((e) => (e.key === 'column' || e.key === 'derived_column') && e.name?.toLowerCase() === column.toLowerCase());
        if (!col || col.value.kind !== 'block') {
            this.warn(`${viewName} (explore_source ${es.name}): column "${column}" not found`);
            return;
        }
        if (col.key === 'derived_column') {
            const sql = (0, parser_1.getText)(col.value.entries, 'sql') ?? '';
            out.transforms.push({ where: `${viewName} (explore_source)`, text: `${tidy(sql)} AS ${column}` });
            for (const r of (0, sql_1.columnRefs)((0, liquid_1.stripLiquid)(sql))) {
                if (!r.qualifier && r.column.toLowerCase() !== column.toLowerCase())
                    this.walkColumn(viewName, r.column, out, seen, depth + 1);
            }
            return;
        }
        const field = (0, parser_1.getText)(col.value.entries, 'field') ?? column;
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
exports.LineageResolver = LineageResolver;
function dedupe(l) {
    const s = new Map();
    for (const x of l.sources)
        s.set(`${x.table.toLowerCase()}|${x.column.toLowerCase()}`, x);
    const t = new Map();
    for (const x of l.transforms)
        t.set(`${x.where}|${x.text}`, x);
    return { sources: [...s.values()], transforms: [...t.values()] };
}
//# sourceMappingURL=lineage.js.map