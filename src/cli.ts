/**
 * CLI for testing without VS Code:
 *   node out/cli.js --root D:/CLT/LOOKML_one_crm_spoke --model customer_relationship_sales_cloud_restricted \
 *     --explore opportunity --out D:/tmp/opportunity.xlsx --remote one-crm-spoke=D:/CLT/LOOKML_one_crm_spoke
 */
import { generate, writeWorkbook } from './core';

function parseArgs(argv: string[]) {
  const out: { root?: string; model?: string; explores: string[]; out?: string; remote: Record<string, string>; json: boolean } = {
    explores: [],
    remote: {},
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--root') out.root = next();
    else if (a === '--model') out.model = next();
    else if (a === '--explore') out.explores.push(next());
    else if (a === '--out') out.out = next();
    else if (a === '--json') out.json = true;
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
  const docs = generate({ root: args.root, model: args.model, explores: args.explores, remoteProjects: args.remote });
  for (const d of docs) console.error(`${d.explore}: ${d.rows.length} fields, ${d.warnings.length} warnings`);
  if (args.json) console.log(JSON.stringify(docs, null, 2));
  if (args.out) {
    await writeWorkbook(docs, args.out);
    console.error(`Written ${args.out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
