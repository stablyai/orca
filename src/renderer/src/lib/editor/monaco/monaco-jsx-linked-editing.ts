import type * as Monaco from 'monaco-editor'
import type { LinkedEditingInfo } from './typescript-worker/orca-typescript-worker'

type MonacoNamespace = typeof Monaco

// Why: Monaco's TypeScriptWorker type does not declare the query that Orca's worker subclass adds.
type LinkedEditingWorker = Monaco.typescript.TypeScriptWorker & {
  getLinkedEditingRangeAtPosition?: (
    fileName: string,
    position: number
  ) => Promise<LinkedEditingInfo | null>
}

/**
 * Renames the matching JSX tag while a tag name is edited (the `linkedEditing` editor option), using
 * TypeScript's own linked-editing query so generics and `<` comparisons are never mistaken for tags.
 */
export function installMonacoJsxLinkedEditing(monaco: MonacoNamespace): void {
  const languages = [
    { id: 'typescript', getWorker: monaco.typescript.getTypeScriptWorker },
    { id: 'javascript', getWorker: monaco.typescript.getJavaScriptWorker }
  ]
  for (const { id, getWorker } of languages) {
    monaco.languages.registerLinkedEditingRangeProvider(id, {
      async provideLinkedEditingRanges(model, position, token) {
        const worker: LinkedEditingWorker = await (await getWorker())(model.uri)
        if (token.isCancellationRequested || model.isDisposed()) {
          return undefined
        }
        // Why: a stock Monaco worker (no Orca subclass) rejects the unknown method.
        const info = await worker
          .getLinkedEditingRangeAtPosition?.(model.uri.toString(), model.getOffsetAt(position))
          .catch(() => null)
        if (!info || token.isCancellationRequested || model.isDisposed()) {
          return undefined
        }
        return {
          ranges: info.ranges.map(({ start, length }) => {
            const from = model.getPositionAt(start)
            const to = model.getPositionAt(start + length)
            return {
              startLineNumber: from.lineNumber,
              startColumn: from.column,
              endLineNumber: to.lineNumber,
              endColumn: to.column
            }
          }),
          ...(info.wordPattern ? { wordPattern: new RegExp(info.wordPattern) } : {})
        }
      }
    })
  }
}
