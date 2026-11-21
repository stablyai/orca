import { TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/tsWorker.js'

export type LinkedEditingInfo = {
  ranges: { start: number; length: number }[]
  wordPattern?: string
}

/** Monaco's TypeScript worker plus the JSX tag linked-editing query its proxy does not expose. */
export class OrcaTypeScriptWorker extends TypeScriptWorker {
  async getLinkedEditingRangeAtPosition(
    fileName: string,
    position: number
  ): Promise<LinkedEditingInfo | null> {
    return this.getLanguageService().getLinkedEditingRangeAtPosition(fileName, position) ?? null
  }
}
