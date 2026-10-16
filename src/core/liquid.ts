import { Liquid } from 'liquidjs';

const engine = new Liquid({ strictVariables: false, strictFilters: false, lenientIf: true });

// Looker-only tags depend on what the user picks at query time: render them as empty text.
for (const tag of ['parameter', 'date_start', 'date_end']) {
  engine.registerTag(tag, { parse() {}, render() { return ''; } });
}
for (const tag of ['condition']) {
  engine.registerTag(tag, {
    parse(_token, remainTokens) {
      while (remainTokens.length) {
        const t = remainTokens.shift()!;
        if ((t as { name?: string }).name === 'endcondition') break;
      }
    },
    render() { return ''; },
  });
}

export interface LiquidContext {
  /** Alias of the view inside the explore (what Looker returns for `_view._name`). */
  view: string;
  /** `alias.field_id` (what Looker returns for `_field._name`). */
  field: string;
  model: string;
  explore: string;
}

const hasLiquid = (text: string) => /\{[{%]/.test(text);

/** Render label-like Liquid the way Looker would at field-picker time. Falls back to the raw text. */
export function renderLiquid(text: string | undefined, ctx: LiquidContext): string | undefined {
  if (text === undefined || !hasLiquid(text)) return text;
  try {
    const out = engine.parseAndRenderSync(text, {
      _view: { _name: ctx.view },
      _field: { _name: ctx.field },
      _model: { _name: ctx.model },
      _explore: { _name: ctx.explore },
    });
    return out.replace(/\s+/g, ' ').trim();
  } catch {
    return text;
  }
}

/**
 * Drop Liquid tags but keep the text of every branch, so `{% if %} ${a} {% else %} ${b} {% endif %}`
 * still exposes both `${a}` and `${b}` for lineage.
 */
export function stripLiquid(text: string): string {
  return text
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, ' ')
    .replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' NULL ');
}

export { hasLiquid };
