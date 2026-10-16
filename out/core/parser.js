"use strict";
/**
 * Minimal LookML parser producing a generic AST.
 *
 *   key: value            -> scalar (bare or quoted)
 *   key: [a, "b", k: v]   -> list
 *   key: name { ... }     -> named block      (view, dimension, join, ...)
 *   key: { ... }          -> anonymous block  (derived_table, allowed_value, ...)
 *   sql: ... ;;           -> expression (raw text up to ';;')
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParseError = void 0;
exports.parseLookml = parseLookml;
exports.getEntry = getEntry;
exports.getText = getText;
exports.getList = getList;
exports.listItemText = listItemText;
exports.getBlock = getBlock;
exports.isYes = isYes;
class ParseError extends Error {
    line;
    constructor(message, line) {
        super(`${message} (line ${line})`);
        this.line = line;
    }
}
exports.ParseError = ParseError;
/** Keys whose value is a SQL/HTML-like expression terminated by `;;`. */
const EXPR_KEYS = new Set([
    'sql', 'html', 'expression', 'expression_custom_filter',
    'sql_table_name', 'sql_on', 'sql_where', 'sql_always_where', 'sql_always_having',
    'sql_trigger', 'sql_trigger_value', 'sql_distinct_key', 'sql_foreign_key',
    'sql_start', 'sql_end', 'sql_create', 'sql_preamble', 'sql_latitude', 'sql_longitude', 'sql_step',
]);
function isExprKey(key) {
    return EXPR_KEYS.has(key) || key.startsWith('sql_');
}
class Parser {
    src;
    pos = 0;
    line = 1;
    constructor(src) {
        this.src = src;
    }
    parseFile() {
        const entries = this.parseEntries(null);
        this.skipTrivia();
        if (this.pos < this.src.length) {
            throw new ParseError(`Unexpected '${this.src[this.pos]}'`, this.line);
        }
        return entries;
    }
    peek() {
        return this.src[this.pos] ?? '';
    }
    advance(n = 1) {
        for (let i = 0; i < n && this.pos < this.src.length; i++) {
            if (this.src[this.pos] === '\n')
                this.line++;
            this.pos++;
        }
    }
    /** Skip whitespace and `#` comments. */
    skipTrivia() {
        while (this.pos < this.src.length) {
            const c = this.src[this.pos];
            if (c === '#') {
                while (this.pos < this.src.length && this.src[this.pos] !== '\n')
                    this.pos++;
            }
            else if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿' || c === '　') {
                this.advance();
            }
            else {
                break;
            }
        }
    }
    parseEntries(end) {
        const entries = [];
        for (;;) {
            this.skipTrivia();
            const c = this.peek();
            if (c === '') {
                if (end)
                    throw new ParseError(`Missing '${end}'`, this.line);
                return entries;
            }
            if (end && c === end) {
                this.advance();
                return entries;
            }
            entries.push(this.parseEntry());
        }
    }
    readBare() {
        const start = this.pos;
        while (this.pos < this.src.length && !/[\s{}\[\],:"#]/.test(this.src[this.pos]))
            this.pos++;
        if (this.pos === start) {
            throw new ParseError(`Unexpected '${this.peek()}'`, this.line);
        }
        return this.src.slice(start, this.pos);
    }
    readString() {
        // assumes current char is '"'
        this.advance();
        let out = '';
        while (this.pos < this.src.length) {
            const c = this.src[this.pos];
            if (c === '\\' && this.pos + 1 < this.src.length) {
                const n = this.src[this.pos + 1];
                out += n === '"' || n === '\\' ? n : c + n;
                this.advance(2);
                continue;
            }
            if (c === '"') {
                this.advance();
                return out;
            }
            out += c;
            this.advance();
        }
        throw new ParseError('Unterminated string', this.line);
    }
    readExpr() {
        const endIdx = this.src.indexOf(';;', this.pos);
        if (endIdx < 0)
            throw new ParseError("Missing ';;'", this.line);
        const text = this.src.slice(this.pos, endIdx);
        this.advance(endIdx + 2 - this.pos);
        return text.trim();
    }
    parseEntry() {
        const line = this.line;
        const key = this.readBare();
        this.skipTrivia();
        if (this.peek() !== ':')
            throw new ParseError(`Expected ':' after '${key}'`, this.line);
        this.advance();
        this.skipTrivia();
        // tolerate typos like `label: : "x"`
        while (this.peek() === ':') {
            this.advance();
            this.skipTrivia();
        }
        const c = this.peek();
        if (isExprKey(key)) {
            return { key, value: { kind: 'expr', text: this.readExpr() }, line };
        }
        if (c === '"') {
            return { key, value: { kind: 'scalar', text: this.readString(), quoted: true }, line };
        }
        if (c === '[') {
            return { key, value: this.parseList(), line };
        }
        if (c === '{') {
            this.advance();
            return { key, value: { kind: 'block', entries: this.parseEntries('}') }, line };
        }
        const token = this.readBare();
        this.skipTrivia();
        if (this.peek() === '{') {
            this.advance();
            return { key, name: token, value: { kind: 'block', entries: this.parseEntries('}') }, line };
        }
        return { key, value: { kind: 'scalar', text: token, quoted: false }, line };
    }
    parseList() {
        this.advance(); // '['
        const items = [];
        for (;;) {
            this.skipTrivia();
            const c = this.peek();
            if (c === '')
                throw new ParseError("Missing ']'", this.line);
            if (c === ']') {
                this.advance();
                return { kind: 'list', items };
            }
            if (c === ',') {
                this.advance();
                continue;
            }
            if (c === '{') {
                this.advance();
                items.push({ kind: 'block', entries: this.parseEntries('}') });
                continue;
            }
            const quoted = c === '"';
            const text = quoted ? this.readString() : this.readBare();
            this.skipTrivia();
            if (this.peek() === ':') {
                this.advance();
                this.skipTrivia();
                const v = this.peek();
                let value;
                if (v === '"')
                    value = { kind: 'scalar', text: this.readString(), quoted: true };
                else if (v === '[')
                    value = this.parseList();
                else
                    value = { kind: 'scalar', text: this.readBare(), quoted: false };
                items.push({ kind: 'pair', key: text, value });
            }
            else {
                items.push({ kind: 'scalar', text, quoted });
            }
        }
    }
}
function parseLookml(text) {
    return new Parser(text).parseFile();
}
// ---------- helpers ----------
/** Last entry with the given key (LookML: last definition wins). */
function getEntry(entries, key) {
    for (let i = entries.length - 1; i >= 0; i--)
        if (entries[i].key === key)
            return entries[i];
    return undefined;
}
/** Text of a scalar or expression property. */
function getText(entries, key) {
    const e = getEntry(entries, key);
    if (!e)
        return undefined;
    if (e.value.kind === 'scalar' || e.value.kind === 'expr')
        return e.value.text;
    return undefined;
}
/** Items of a list property as plain strings (pairs rendered as `key: value`). */
function getList(entries, key) {
    const e = getEntry(entries, key);
    if (!e)
        return undefined;
    if (e.value.kind === 'list')
        return e.value.items.map(listItemText);
    if (e.value.kind === 'scalar')
        return [e.value.text];
    return undefined;
}
function listItemText(item) {
    if (item.kind === 'scalar')
        return item.text;
    if (item.kind === 'pair') {
        const v = item.value;
        const vt = v.kind === 'scalar' ? (v.quoted ? `"${v.text}"` : v.text)
            : v.kind === 'list' ? `[${v.items.map(listItemText).join(', ')}]` : '';
        return `${item.key}: ${vt}`;
    }
    return '{...}';
}
function getBlock(entries, key) {
    const e = getEntry(entries, key);
    return e && e.value.kind === 'block' ? e.value.entries : undefined;
}
function isYes(entries, key) {
    const t = getText(entries, key);
    if (t === undefined)
        return undefined;
    return t.trim().toLowerCase() === 'yes';
}
//# sourceMappingURL=parser.js.map