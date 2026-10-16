"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COLUMNS = void 0;
exports.titleCase = titleCase;
exports.documentExplore = documentExplore;
const parser_1 = require("./parser");
const liquid_1 = require("./liquid");
const lineage_1 = require("./lineage");
exports.COLUMNS = [
    { key: 'lookerLabel', header: 'Looker Label', width: 32 },
    { key: 'viewLabel', header: 'Looker View Label', width: 24 },
    { key: 'groupLabel', header: 'Looker Group Label', width: 24 },
    { key: 'groupItemLabel', header: 'Group Item Label', width: 22 },
    { key: 'category', header: 'Category', width: 12 },
    { key: 'description', header: 'Description', width: 40 },
    { key: 'key', header: 'Key', width: 40 },
    { key: 'viewName', header: 'View Name', width: 26 },
    { key: 'fieldId', header: 'Field Identifier', width: 30 },
    { key: 'martTable', header: 'Mart Table / View', width: 36 },
    { key: 'martColumn', header: 'Mart / View Column Field Name', width: 32 },
    { key: 'bizLogic', header: 'BIZ Logic for LM', width: 70 },
];
const DEFAULT_TIMEFRAMES = ['raw', 'time', 'date', 'week', 'month', 'quarter', 'year'];
const DEFAULT_INTERVALS = ['day', 'hour', 'minute', 'month', 'quarter', 'second', 'week', 'year'];
/** Looker's default label: snake_case -> Title Case, `id` -> `ID`. */
function titleCase(name) {
    return name
        .split('_')
        .filter(Boolean)
        .map((w) => (w.toLowerCase() === 'id' ? 'ID' : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}
function expandField(def) {
    if (def.kind !== 'dimension_group')
        return [{ fieldId: def.name }];
    const type = ((0, parser_1.getText)(def.entries, 'type') ?? 'time').toLowerCase();
    if (type === 'duration') {
        return ((0, parser_1.getList)(def.entries, 'intervals') ?? DEFAULT_INTERVALS).map((i) => ({ fieldId: `${i}s_${def.name}`, interval: i }));
    }
    return ((0, parser_1.getList)(def.entries, 'timeframes') ?? DEFAULT_TIMEFRAMES)
        .filter((t) => t !== 'raw') // raw is never shown in the field picker
        .map((t) => ({ fieldId: `${def.name}_${t}`, timeframe: t }));
}
/** Parsed `fields:` list: which `alias.field` keys are included / excluded. */
class FieldFilter {
    sets;
    all = false;
    allOf = new Set();
    keys = new Set();
    negKeys = new Set();
    negAllOf = new Set();
    positives = 0;
    constructor(items, defaultAlias, sets) {
        this.sets = sets;
        for (const raw of items)
            this.add(raw.trim(), defaultAlias, new Set());
    }
    add(item, defaultAlias, guard) {
        const neg = item.startsWith('-');
        const body = neg ? item.slice(1) : item;
        if (!neg)
            this.positives++;
        if (body === 'ALL_FIELDS*') {
            if (neg)
                this.negAllOf.add(defaultAlias);
            else
                this.all = true;
            return;
        }
        const [alias, name] = body.includes('.') ? body.split('.', 2) : [defaultAlias, body];
        if (name.endsWith('*')) {
            const setName = name.slice(0, -1);
            if (setName === 'ALL_FIELDS' || setName === '') {
                (neg ? this.negAllOf : this.allOf).add(alias);
                return;
            }
            const setItems = this.sets(alias)?.get(setName);
            const gk = `${alias}.${setName}`;
            if (!setItems || guard.has(gk))
                return;
            guard.add(gk);
            for (const s of setItems) {
                const sNeg = s.trim().startsWith('-');
                const sBody = sNeg ? s.trim().slice(1) : s.trim();
                // a negation inside a set flips relative to the set's own sign
                this.add((neg !== sNeg ? '-' : '') + sBody, alias, guard);
            }
            return;
        }
        (neg ? this.negKeys : this.keys).add(`${alias}.${name}`);
    }
    allows(alias, fieldId, groupName) {
        const k = `${alias}.${fieldId}`;
        const g = groupName ? `${alias}.${groupName}` : undefined;
        if (this.negKeys.has(k) || (g && this.negKeys.has(g)) || this.negAllOf.has(alias))
            return false;
        if (this.positives === 0)
            return true; // only exclusions listed
        return this.all || this.allOf.has(alias) || this.keys.has(k) || (!!g && this.keys.has(g));
    }
}
function documentExplore(model, exploreName) {
    const warnings = [];
    const warn = (m) => {
        if (!warnings.includes(m))
            warnings.push(m);
    };
    const explore = model.getExplore(exploreName);
    if (!explore)
        throw new Error(`Explore "${exploreName}" not found in model ${model.name}`);
    const views = new Map();
    for (const a of explore.aliases) {
        const v = model.getView(a.viewName);
        if (v)
            views.set(a.alias, v);
        else
            warn(`Explore ${exploreName}: view "${a.viewName}" (alias ${a.alias}) not found`);
    }
    const setsOf = (alias) => views.get(alias)?.sets;
    const exploreFields = (0, parser_1.getList)(explore.entries, 'fields');
    const exploreFilter = exploreFields ? new FieldFilter(exploreFields, explore.aliases[0].alias, setsOf) : undefined;
    const resolver = new lineage_1.LineageResolver(model, explore, warn);
    const rows = [];
    for (const alias of explore.aliases) {
        const view = views.get(alias.alias);
        if (!view)
            continue;
        const joinFields = alias.join ? (0, parser_1.getList)(alias.join, 'fields') : undefined;
        const joinFilter = joinFields ? new FieldFilter(joinFields, alias.alias, setsOf) : undefined;
        for (const def of view.fields.values()) {
            if ((0, parser_1.isYes)(def.entries, 'hidden'))
                continue;
            for (const x of expandField(def)) {
                const groupName = def.kind === 'dimension_group' ? def.name : undefined;
                if (exploreFilter && !exploreFilter.allows(alias.alias, x.fieldId, groupName))
                    continue;
                if (joinFields && joinFields.length === 0)
                    continue; // fields: []
                if (joinFilter && !joinFilter.allows(alias.alias, x.fieldId, groupName))
                    continue;
                rows.push(buildRow(model, explore, { alias, view, def, ...x }, resolver));
            }
        }
    }
    const label = (0, parser_1.getText)(explore.entries, 'label') ?? titleCase(exploreName);
    return { model: model.name, explore: exploreName, label, rows, warnings };
}
function buildRow(model, explore, c, resolver) {
    const { alias, view, def, fieldId } = c;
    const ctx = { view: alias.alias, field: `${alias.alias}.${fieldId}`, model: model.name, explore: explore.name };
    const r = (t) => (0, liquid_1.renderLiquid)(t === undefined ? t : model.project.applyConstants(t), ctx) ?? '';
    // ----- labels -----
    const rawLabel = (0, parser_1.getText)(def.entries, 'label');
    let lookerLabel;
    if (c.timeframe) {
        lookerLabel = `${r(rawLabel) || titleCase(def.name)} ${titleCase(c.timeframe).replace(/ Of /g, ' of ')}`;
    }
    else if (c.interval) {
        lookerLabel = `${titleCase(c.interval)}s ${r(rawLabel) || titleCase(def.name)}`;
    }
    else {
        lookerLabel = r(rawLabel) || titleCase(def.name);
    }
    const viewLabel = r((0, parser_1.getText)(def.entries, 'view_label')) ||
        r(alias.isBase ? (0, parser_1.getText)(explore.entries, 'view_label') : (0, parser_1.getText)(alias.join ?? [], 'view_label')) ||
        r((0, parser_1.getText)(view.entries, 'view_label')) ||
        r((0, parser_1.getText)(view.entries, 'label')) ||
        (alias.isBase ? r((0, parser_1.getText)(explore.entries, 'label')) : '') ||
        titleCase(alias.alias);
    // ----- lineage -----
    const ref = (0, lineage_1.lookupField)(view, fieldId) ?? { def };
    const lineage = resolver.resolve(view.name, ref, fieldId);
    const byTable = new Map();
    for (const s of lineage.sources) {
        const cols = byTable.get(s.table) ?? [];
        if (!cols.some((x) => x.toLowerCase() === s.column.toLowerCase()))
            cols.push(s.column);
        byTable.set(s.table, cols);
    }
    const bizLogic = lineage.transforms
        .map((t) => (t.where ? `[${t.where}]\n${t.text}` : t.text))
        .join('\n\n');
    return {
        lookerLabel,
        viewLabel,
        groupLabel: r((0, parser_1.getText)(def.entries, 'group_label')),
        groupItemLabel: r((0, parser_1.getText)(def.entries, 'group_item_label')),
        category: def.kind === 'dimension_group' ? 'dimension' : def.kind,
        description: r((0, parser_1.getText)(def.entries, 'description')),
        key: `${view.name}.${fieldId}`,
        viewName: view.name,
        fieldId,
        martTable: [...byTable.keys()].join('\n'),
        martColumn: [...byTable.values()].map((cols) => cols.join(', ')).join('\n'),
        bizLogic,
        alias: alias.alias,
    };
}
//# sourceMappingURL=document.js.map