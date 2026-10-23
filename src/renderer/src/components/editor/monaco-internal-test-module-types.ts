// Test-only types for Monaco internals the model-URI tests drive directly (the TypeScript worker
// and the snippet resolver). A script file, so these stay ambient module declarations.
declare module 'monaco-editor/esm/vs/language/typescript/tsWorker.js' {
  import type { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
  export class TypeScriptWorker {
    constructor(
      context: { getMirrorModels(): { uri: URI; version: number; getValue(): string }[] },
      createData: {
        compilerOptions: Record<string, unknown>
        extraLibs: Record<string, unknown>
        inlayHintsOptions: Record<string, unknown>
      }
    )
    getScriptKind(fileName: string): number
    getQuickInfoAtPosition(
      fileName: string,
      position: number
    ): Promise<{ displayParts?: readonly { text: string }[] } | undefined>
    getDefinitionAtPosition(
      fileName: string,
      position: number
    ): Promise<readonly { fileName: string }[] | undefined>
  }
}

declare module 'monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js' {
  export const ScriptKind: { readonly TSX: number }
}

declare module 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetVariables.js' {
  export class ModelBasedVariableResolver {
    constructor(labelService: unknown, model: unknown)
    resolve(variable: { name: string }): string | undefined
  }
}

declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { get(serviceId: unknown): unknown }
}

declare module 'monaco-editor/esm/vs/platform/label/common/label.js' {
  export const ILabelService: unknown
}
