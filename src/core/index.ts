import * as path from 'path';
import { LookmlProject } from './project';
import { LookmlModel } from './model';
import { documentExplore, ExploreDoc } from './document';

export * from './document';
export { writeWorkbook } from './excel';
export { LookmlProject } from './project';
export { LookmlModel } from './model';

export interface GenerateOptions {
  root: string;
  remoteProjects?: Record<string, string>;
  /** Model name (file name without .model.lkml). */
  model: string;
  /** Explores to document; empty = every explore in the model. */
  explores?: string[];
}

export function openModel(project: LookmlProject, modelName: string): LookmlModel {
  const file = project.modelFiles().find((f) => path.posix.basename(f.relPath) === `${modelName}.model.lkml`);
  if (!file) throw new Error(`Model "${modelName}" not found`);
  return new LookmlModel(project, file);
}

export function generate(opts: GenerateOptions): ExploreDoc[] {
  const project = new LookmlProject({ root: opts.root, remoteProjects: opts.remoteProjects });
  const model = openModel(project, opts.model);
  const names = opts.explores?.length ? opts.explores : model.exploreNames();
  const docs = names.map((n) => documentExplore(model, n));
  // project-level warnings (includes, parse errors) are attached to every explore sheet once
  const projectWarnings = project.warnings.list();
  for (const d of docs) d.warnings.unshift(...projectWarnings.filter((w) => !d.warnings.includes(w)));
  return docs;
}
