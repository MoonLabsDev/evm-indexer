import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

export interface InitResult { written: string[]; skipped: string[] }

const TEMPLATE_DIR = join(__dirname, '..', '..', 'templates', 'init');
/** Never replaced, not even with force: it is the user's own compiler setup. */
const KEEP = new Set(['tsconfig.json']);

/** Template files relative to the template dir, '/'-separated. */
function listTemplates(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listTemplates(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function targetOf(template: string): string {
  if (template === 'env.example') return '.env.example';
  return template.endsWith('.tpl') ? template.slice(0, -'.tpl'.length) : template;
}

/** Writes the demo project into `root`. Existing files are kept unless `force` is set (tsconfig.json always is). */
export function cmdInit(root: string, opts: { force: boolean }): InitResult {
  const result: InitResult = { written: [], skipped: [] };
  mkdirSync(root, { recursive: true });
  for (const template of listTemplates(TEMPLATE_DIR)) {
    const target = targetOf(template);
    const path = join(root, ...target.split('/'));
    if (existsSync(path) && (!opts.force || KEEP.has(target))) {
      result.skipped.push(target);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(TEMPLATE_DIR, ...template.split('/')), path);
    result.written.push(target);
  }
  return result;
}
