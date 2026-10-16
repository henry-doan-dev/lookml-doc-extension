"use strict";
/**
 * Lightweight BigQuery SELECT analyser, good enough for column-level lineage of derived tables:
 * CTEs, UNION branches, sub-queries, `expr AS alias`, `FROM x AS a JOIN y b ON ...`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQL_KEYWORDS = exports.VIEW_PLACEHOLDER = void 0;
exports.stripSqlComments = stripSqlComments;
exports.maskTopLevel = maskTopLevel;
exports.parseQuery = parseQuery;
exports.columnRefs = columnRefs;
exports.isDirectColumn = isDirectColumn;
exports.queryHasColumn = queryHasColumn;
exports.VIEW_PLACEHOLDER = '__LKV__';
const CLAUSE_END = /\b(WHERE|GROUP\s+BY|HAVING|QUALIFY|WINDOW|ORDER\s+BY|LIMIT)\b/i;
exports.SQL_KEYWORDS = new Set(`
select from where case when then else end and or not null is in as on true false
date timestamp datetime time interval day days month year week quarter hour minute second millisecond microsecond
dayofweek dayofyear isoweek isoyear monday tuesday wednesday thursday friday saturday sunday
like between distinct over partition by order asc desc rows range unbounded preceding following current row
cast safe_cast int64 string float64 numeric bignumeric bool boolean bytes array struct json geography
extract at zone ignore respect nulls first last limit unnest with offset ordinal except replace escape all any some exists
group having qualify window join left right inner outer full cross using union intersect for tablesample pivot unpivot
if ifnull coalesce nullif
`.split(/\s+/).filter(Boolean));
/** Remove `-- ...`, `# ...` and `/* ... *\/` comments while keeping string literals intact. */
function stripSqlComments(sql) {
    let out = '';
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`') {
            const end = findStringEnd(sql, i);
            out += sql.slice(i, end);
            i = end;
        }
        else if ((c === '-' && sql[i + 1] === '-') || c === '#') {
            while (i < sql.length && sql[i] !== '\n')
                i++;
        }
        else if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 2;
            out += ' ';
        }
        else {
            out += c;
            i++;
        }
    }
    return out;
}
function findStringEnd(sql, start) {
    const q = sql[start];
    // triple-quoted
    if (q !== '`' && sql.startsWith(q.repeat(3), start)) {
        const end = sql.indexOf(q.repeat(3), start + 3);
        return end < 0 ? sql.length : end + 3;
    }
    let i = start + 1;
    while (i < sql.length) {
        if (sql[i] === '\\') {
            i += 2;
            continue;
        }
        if (sql[i] === q)
            return i + 1;
        i++;
    }
    return sql.length;
}
/**
 * Same length as `sql`: string literals become `§`, content nested inside (), [] becomes spaces.
 * Lets us search for top-level keywords/commas with plain regexes and slice the original text.
 */
function maskTopLevel(sql, keepNested = false) {
    const out = [];
    let depth = 0;
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`') {
            const end = findStringEnd(sql, i);
            const fill = c === '`' ? 'x' : '§'; // § is not a word char, so literals never look like identifiers
            for (let k = i; k < end; k++)
                out.push(depth > 0 && !keepNested ? ' ' : (sql[k] === '\n' ? '\n' : fill));
            i = end;
            continue;
        }
        if (c === '(' || c === '[') {
            out.push(depth > 0 && !keepNested ? ' ' : c);
            depth++;
        }
        else if (c === ')' || c === ']') {
            depth = Math.max(0, depth - 1);
            out.push(depth > 0 && !keepNested ? ' ' : c);
        }
        else {
            out.push(depth > 0 && !keepNested ? (c === '\n' ? '\n' : ' ') : c);
        }
        i++;
    }
    return out.join('');
}
/** Split `text` at top-level matches of `re` (global). Returns the pieces between matches. */
function splitTopLevel(text, re) {
    const mask = maskTopLevel(text);
    const parts = [];
    let last = 0;
    for (const m of mask.matchAll(re)) {
        parts.push(text.slice(last, m.index));
        last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return parts;
}
function matchingParen(text, open) {
    const mask = maskTopLevel(text, true);
    let depth = 0;
    for (let i = open; i < mask.length; i++) {
        if (mask[i] === '(')
            depth++;
        else if (mask[i] === ')') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
function unwrapParens(sql) {
    let s = sql.trim();
    while (s.startsWith('(') && matchingParen(s, 0) === s.length - 1)
        s = s.slice(1, -1).trim();
    return s;
}
function parseQuery(sqlText, ctes = new Map()) {
    let sql = unwrapParens(stripSqlComments(sqlText).replace(/;\s*$/, ''));
    const scope = new Map(ctes);
    // WITH a AS (...), b AS (...)
    const withM = /^WITH\s+(RECURSIVE\s+)?/i.exec(sql);
    if (withM) {
        let pos = withM[0].length;
        for (;;) {
            const head = /^\s*`?(\w+)`?\s*(\([^)]*\)\s*)?AS\s*\(/i.exec(sql.slice(pos));
            if (!head)
                break;
            const open = pos + head[0].length - 1;
            const close = matchingParen(sql, open);
            if (close < 0)
                break;
            scope.set(head[1].toLowerCase(), sql.slice(open + 1, close));
            pos = close + 1;
            const comma = /^\s*,/.exec(sql.slice(pos));
            if (!comma)
                break;
            pos += comma[0].length;
        }
        sql = sql.slice(pos).trim();
    }
    const branches = splitTopLevel(sql, /\b(UNION|INTERSECT|EXCEPT)\s+(ALL|DISTINCT)\b/gi);
    const queries = branches.map((b) => parseSimpleSelect(unwrapParens(b), scope));
    const [first, ...rest] = queries;
    first.unions.push(...rest);
    return first;
}
function parseSimpleSelect(sql, ctes) {
    const q = { items: [], sources: new Map(), unions: [] };
    const mask = maskTopLevel(sql);
    const sel = /\bSELECT\b/i.exec(mask);
    if (!sel)
        return q;
    const afterSelect = sel.index + sel[0].length;
    const fromM = /\bFROM\b/i.exec(mask.slice(afterSelect));
    const listEnd = fromM ? afterSelect + fromM.index : sql.length;
    let list = sql.slice(afterSelect, listEnd);
    list = list.replace(/^\s*(DISTINCT|ALL)\b/i, '').replace(/^\s*AS\s+(STRUCT|VALUE)\b/i, '');
    for (const raw of splitTopLevel(list, /,/g)) {
        const item = parseSelectItem(raw);
        if (item)
            q.items.push(item);
    }
    if (fromM) {
        const fromStart = listEnd + fromM[0].length;
        const rest = sql.slice(fromStart);
        const end = CLAUSE_END.exec(maskTopLevel(rest));
        const fromText = end ? rest.slice(0, end.index) : rest;
        parseFrom(fromText, q, ctes);
    }
    return q;
}
function parseSelectItem(raw) {
    const text = raw.trim();
    if (!text)
        return null;
    const mask = maskTopLevel(text);
    const star = /^(?:(`?[\w.]+`?)\.)?\*(\s*(EXCEPT|REPLACE)\s*\(.*)?$/is.exec(mask.trim());
    if (star)
        return { alias: null, expr: text, star: star[1] ? star[1].replace(/`/g, '') : true };
    const asM = /\s+AS\s+(`?\w+`?)\s*$/i.exec(mask);
    if (asM)
        return { alias: asM[1].replace(/`/g, ''), expr: text.slice(0, asM.index).trim() };
    // bare column: `t.col` / `col`
    const bare = /^(?:`?[\w]+`?\.)*`?(\w+)`?$/.exec(text);
    if (bare)
        return { alias: bare[1], expr: text };
    // implicit alias: `expr alias`
    const imp = /^([\s\S]*\S)\s+`?([A-Za-z_]\w*)`?$/.exec(mask);
    if (imp && !exports.SQL_KEYWORDS.has(imp[2].toLowerCase()) && !/[-+*/|=<>,.(]$/.test(imp[1].trim())) {
        return { alias: imp[2], expr: text.slice(0, imp[1].length).trim() };
    }
    return { alias: null, expr: text };
}
function parseFrom(fromText, q, ctes) {
    const segments = splitTopLevel(fromText, /,|\b(?:(?:LEFT|RIGHT|FULL|INNER|CROSS)\s+(?:OUTER\s+)?)?JOIN\b/gi);
    for (let seg of segments) {
        const m = maskTopLevel(seg);
        const on = /\b(ON|USING)\b/i.exec(m);
        if (on)
            seg = seg.slice(0, on.index);
        seg = seg.trim();
        if (!seg)
            continue;
        let source;
        let rest;
        let dflt;
        if (seg.startsWith('(')) {
            const close = matchingParen(seg, 0);
            const inner = seg.slice(1, close).trim();
            if (/^(`[^`]+`|[\w.\-]+)$/.test(inner)) {
                // `( table )` or `( ${view.SQL_TABLE_NAME} )` - a plain relation in parentheses
                const name = inner.replace(/`/g, '');
                source = name.startsWith(exports.VIEW_PLACEHOLDER)
                    ? { kind: 'view', name: name.slice(exports.VIEW_PLACEHOLDER.length) }
                    : { kind: 'table', name };
            }
            else {
                source = { kind: 'query', query: parseQuery(inner, ctes) };
            }
            rest = seg.slice(close + 1);
        }
        else if (/^UNNEST\s*\(/i.test(seg)) {
            const open = seg.indexOf('(');
            const close = matchingParen(seg, open);
            source = { kind: 'unnest' };
            rest = seg.slice(close + 1);
        }
        else {
            const tm = /^(`[^`]+`|[\w.\-]+)/.exec(seg);
            if (!tm)
                continue;
            const name = tm[1].replace(/`/g, '');
            rest = seg.slice(tm[0].length);
            if (name.startsWith(exports.VIEW_PLACEHOLDER)) {
                source = { kind: 'view', name: name.slice(exports.VIEW_PLACEHOLDER.length) };
            }
            else if (ctes.has(name.toLowerCase())) {
                // a CTE body cannot see itself (avoids infinite recursion on `WITH x AS (SELECT ... FROM x)`)
                const inner = new Map(ctes);
                inner.delete(name.toLowerCase());
                source = { kind: 'query', query: parseQuery(ctes.get(name.toLowerCase()), inner) };
            }
            else {
                source = { kind: 'table', name };
            }
            // without an explicit alias a relation is referenced by its last name part
            dflt = source.kind === 'view' ? source.name : name.split('.').pop();
        }
        // relation PIVOT ( agg AS a, ... FOR col IN (...) ) [AS] alias
        const pv = /^\s*(UN)?PIVOT\s*\(/i.exec(rest);
        if (pv) {
            const open = pv[0].length - 1;
            const close = matchingParen(rest, open);
            const body = rest.slice(open + 1, close < 0 ? rest.length : close);
            let aggs = [];
            if (!pv[1]) {
                const forAt = /\bFOR\b/i.exec(maskTopLevel(body));
                aggs = splitTopLevel(forAt ? body.slice(0, forAt.index) : body, /,/g)
                    .map(parseSelectItem)
                    .filter((i) => !!i);
            }
            source = { kind: 'pivot', inner: source, aggs };
            rest = close < 0 ? '' : rest.slice(close + 1);
        }
        const am = /^\s*(?:AS\s+)?`?([A-Za-z_]\w*)`?/i.exec(rest);
        if (am && !exports.SQL_KEYWORDS.has(am[1].toLowerCase()))
            q.sources.set(am[1].toLowerCase(), source);
        else if (dflt)
            q.sources.set(dflt.toLowerCase(), source);
        else if (source.kind !== 'unnest')
            q.sources.set(`__anon${q.sources.size}`, source);
    }
}
/** Column references inside an expression (function names and keywords are skipped). */
function columnRefs(expr) {
    const masked = maskTopLevel(expr, true);
    const refs = [];
    const re = /(?<![\w.@$])((?:`[^`]+`|[A-Za-z_]\w*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_]\w*))*)/g;
    // backticked identifiers were masked to x...x, so read them from the original text at the same offsets
    for (const m of masked.matchAll(re)) {
        const original = expr.slice(m.index, m.index + m[0].length);
        const next = masked.slice(m.index + m[0].length).match(/^\s*(\S)/);
        if (next && next[1] === '(')
            continue; // function call
        const after = expr[m.index + m[0].length];
        if ((after === "'" || after === '"') && /^[rRbB]{1,2}$/.test(m[0]))
            continue; // r'...' / b'...' literal prefix
        const parts = original.split('.').map((p) => p.trim().replace(/`/g, ''));
        if (parts.length === 1) {
            if (exports.SQL_KEYWORDS.has(parts[0].toLowerCase()) || /^\d/.test(parts[0]))
                continue;
            refs.push({ column: parts[0] });
        }
        else {
            refs.push({ qualifier: parts[0].toLowerCase(), column: parts[1] });
        }
    }
    return refs;
}
/** True when an expression is just a (qualified) column reference. */
function isDirectColumn(expr) {
    return /^(?:`?\w+`?\s*\.\s*)*`?\w+`?$/.test(expr.trim());
}
/** Whether a query may expose `column`: directly, or through `*` over a relation that (may) have it. */
function queryHasColumn(q, column, depth = 0) {
    const c = column.toLowerCase();
    if (q.items.some((i) => i.alias?.toLowerCase() === c))
        return true;
    if (depth > 20)
        return false;
    for (const i of q.items) {
        if (!i.star)
            continue;
        const srcs = i.star === true ? [...q.sources.values()] : [q.sources.get(i.star.toLowerCase())];
        for (const s of srcs) {
            if (!s)
                continue;
            if (s.kind === 'table' || s.kind === 'view' || s.kind === 'pivot')
                return true; // opaque relation: assume it has the column
            if (s.kind === 'query' && queryHasColumn(s.query, column, depth + 1))
                return true;
        }
    }
    return false;
}
//# sourceMappingURL=sql.js.map