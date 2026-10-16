"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LookmlModel = exports.LookmlProject = exports.writeWorkbook = void 0;
exports.openModel = openModel;
exports.generate = generate;
const path = __importStar(require("path"));
const project_1 = require("./project");
const model_1 = require("./model");
const document_1 = require("./document");
__exportStar(require("./document"), exports);
var excel_1 = require("./excel");
Object.defineProperty(exports, "writeWorkbook", { enumerable: true, get: function () { return excel_1.writeWorkbook; } });
var project_2 = require("./project");
Object.defineProperty(exports, "LookmlProject", { enumerable: true, get: function () { return project_2.LookmlProject; } });
var model_2 = require("./model");
Object.defineProperty(exports, "LookmlModel", { enumerable: true, get: function () { return model_2.LookmlModel; } });
function openModel(project, modelName) {
    const file = project.modelFiles().find((f) => path.posix.basename(f.relPath) === `${modelName}.model.lkml`);
    if (!file)
        throw new Error(`Model "${modelName}" not found`);
    return new model_1.LookmlModel(project, file);
}
function generate(opts) {
    const project = new project_1.LookmlProject({ root: opts.root, remoteProjects: opts.remoteProjects });
    const model = openModel(project, opts.model);
    const names = opts.explores?.length ? opts.explores : model.exploreNames();
    const docs = names.map((n) => (0, document_1.documentExplore)(model, n));
    // project-level warnings (includes, parse errors) are attached to every explore sheet once
    const projectWarnings = project.warnings.list();
    for (const d of docs)
        d.warnings.unshift(...projectWarnings.filter((w) => !d.warnings.includes(w)));
    return docs;
}
//# sourceMappingURL=index.js.map