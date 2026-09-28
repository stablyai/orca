import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'

const FILE_SCHEME = /^file:/i

/**
 * The single filesystem-path -> Monaco model key function. Monaco keys its model registry by
 * `uri.toString()`, so creation, lookup and ownership comparison must all go through this.
 *
 * Why not `Uri.parse`: it reads `C:\src\a.ts` as scheme `c`, which fails the scheme gate in
 * `modelService._schemaShouldMaintainUndoRedoElements`, so closed-file undo is dropped for every
 * file on Windows. `Uri.file` always yields the `file:` scheme that gate allows, and the result
 * re-parses to itself, so a consumer that can only take a string (the `path` prop of
 * `@monaco-editor/react`, which calls `Uri.parse` internally) lands on the same key.
 */
export function toEditorModelUri(filePath: string): string {
  return URI.file(FILE_SCHEME.test(filePath) ? URI.parse(filePath).fsPath : filePath).toString()
}
