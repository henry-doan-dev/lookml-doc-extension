"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * CLI for testing without VS Code:
 *   node out/cli.js --root D:/CLT/LOOKML_one_crm_spoke --model customer_relationship_sales_cloud_restricted \
 *     --explore opportunity --out D:/tmp/opportunity.xlsx --remote one-crm-spoke=D:/CLT/LOOKML_one_crm_spoke
 */
const core_1 = require("./core");
function parseArgs(argv) {
    const out = {
        explores: [],
        remote: {},
        json: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--root')
            out.root = next();
        else if (a === '--model')
            out.model = next();
        else if (a === '--explore')
            out.explores.push(next());
        else if (a === '--out')
            out.out = next();
        else if (a === '--json')
            out.json = true;
        else if (a === '--remote') {
            const [k, ...v] = next().split('=');
            out.remote[k] = v.join('=');
        }
    }
    return out;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.root || !args.model) {
        console.error('Usage: --root <project> --model <model> [--explore <name>]... [--out file.xlsx] [--remote name=path] [--json]');
        process.exit(1);
    }
    const docs = (0, core_1.generate)({ root: args.root, model: args.model, explores: args.explores, remoteProjects: args.remote });
    for (const d of docs)
        console.error(`${d.explore}: ${d.rows.length} fields, ${d.warnings.length} warnings`);
    if (args.json)
        console.log(JSON.stringify(docs, null, 2));
    if (args.out) {
        await (0, core_1.writeWorkbook)(docs, args.out);
        console.error(`Written ${args.out}`);
    }
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map