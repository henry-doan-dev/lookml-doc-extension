"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasLiquid = void 0;
exports.renderLiquid = renderLiquid;
exports.stripLiquid = stripLiquid;
const liquidjs_1 = require("liquidjs");
const engine = new liquidjs_1.Liquid({ strictVariables: false, strictFilters: false, lenientIf: true });
// Looker-only tags depend on what the user picks at query time: render them as empty text.
for (const tag of ['parameter', 'date_start', 'date_end']) {
    engine.registerTag(tag, { parse() { }, render() { return ''; } });
}
for (const tag of ['condition']) {
    engine.registerTag(tag, {
        parse(_token, remainTokens) {
            while (remainTokens.length) {
                const t = remainTokens.shift();
                if (t.name === 'endcondition')
                    break;
            }
        },
        render() { return ''; },
    });
}
const hasLiquid = (text) => /\{[{%]/.test(text);
exports.hasLiquid = hasLiquid;
/** Render label-like Liquid the way Looker would at field-picker time. Falls back to the raw text. */
function renderLiquid(text, ctx) {
    if (text === undefined || !hasLiquid(text))
        return text;
    try {
        const out = engine.parseAndRenderSync(text, {
            _view: { _name: ctx.view },
            _field: { _name: ctx.field },
            _model: { _name: ctx.model },
            _explore: { _name: ctx.explore },
        });
        return out.replace(/\s+/g, ' ').trim();
    }
    catch {
        return text;
    }
}
/**
 * Drop Liquid tags but keep the text of every branch, so `{% if %} ${a} {% else %} ${b} {% endif %}`
 * still exposes both `${a}` and `${b}` for lineage.
 */
function stripLiquid(text) {
    return text
        .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, ' ')
        .replace(/\{%[\s\S]*?%\}/g, ' ')
        .replace(/\{\{[\s\S]*?\}\}/g, ' NULL ');
}
//# sourceMappingURL=liquid.js.map