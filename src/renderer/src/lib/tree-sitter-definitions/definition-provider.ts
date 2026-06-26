import type * as Monaco from 'monaco-editor'
import { PROVIDER_LANGUAGE_IDS, grammarForPath } from './language-registry'
import { resolveDefinitions, type ResolverContext } from './definition-resolver'
import { extractDefinitions } from './engine'

type MonacoApi = typeof Monaco

// Store-backed seams, injected at registration so this module stays decoupled.
export type DefinitionProviderHooks = {
  // Resolve the runtime context (worktree + settings) for the file under edit.
  getContext: (filePath: string) => ResolverContext | null
  // Open a cross-file definition target in Orca's editor (tab + reveal).
  openTarget: (filePath: string, line: number, column: number) => void
}

// Map the definition URIs we return back to their absolute paths. The opener
// reads this instead of re-deriving a path from the URI (lossy for Windows
// drive letters), and it scopes the opener to targets WE produced — every other
// navigation falls through to Monaco's default.
const MAX_TARGETS = 256
const targetPaths = new Map<string, string>()
// Skip the current-file pre-parse for very large buffers (perf); fall back to
// the worktree search.
const SAME_FILE_PARSE_MAX_CHARS = 512 * 1024

/** Record a URI→absolute-path mapping for a target we produced, evicting the oldest past {@link MAX_TARGETS}. */
function rememberTarget(uriString: string, filePath: string): void {
  if (targetPaths.size >= MAX_TARGETS) {
    const oldest = targetPaths.keys().next().value
    if (oldest !== undefined) {
      targetPaths.delete(oldest)
    }
  }
  targetPaths.set(uriString, filePath)
}

/** Normalize a Monaco selection or position to a 1-based { line, column } (defaults to 1,1). */
function positionLineColumn(selectionOrPosition?: Monaco.IRange | Monaco.IPosition): {
  line: number
  column: number
} {
  if (!selectionOrPosition) {
    return { line: 1, column: 1 }
  }
  if ('startLineNumber' in selectionOrPosition) {
    return { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
  }
  return { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
}

// Survives HMR so only one provider + opener is ever active.
type ProviderGlobal = typeof globalThis & { __treeSitterDefs?: Monaco.IDisposable }

/**
 * Register the cross-file Go-to-Definition provider and editor opener on Monaco,
 * disposing any prior registration so only one stays active across HMR.
 */
export function registerTreeSitterDefinitions(
  monaco: MonacoApi,
  hooks: DefinitionProviderHooks
): void {
  const g = globalThis as ProviderGlobal
  g.__treeSitterDefs?.dispose()

  const subs: Monaco.IDisposable[] = []

  subs.push(
    monaco.languages.registerDefinitionProvider([...PROVIDER_LANGUAGE_IDS], {
      async provideDefinition(model, position, token) {
        const word = model.getWordAtPosition(position)?.word
        if (!word) {
          return null
        }
        // Only the extension is read from this path, which survives URI mangling.
        const filePath = model.uri.fsPath || model.uri.path
        // Skip files whose grammar we don't have (e.g. .zsh/.fish share Monaco's
        // 'shell' id but have no grammar here) rather than leak cross-language hits.
        const fromGrammar = grammarForPath(filePath)
        if (!fromGrammar) {
          return null
        }
        // Prefer a definition in the current file — right scope, and it skips the
        // worktree search. Monaco reveals it in place (same model, no opener).
        const content = model.getValue()
        if (content.length <= SAME_FILE_PARSE_MAX_CHARS) {
          try {
            const here = (await extractDefinitions(fromGrammar, content)).find(
              (d) => d.name === word
            )
            if (here) {
              const range = new monaco.Range(
                here.line,
                here.column,
                here.line,
                here.column + word.length
              )
              return [{ uri: model.uri, range }]
            }
          } catch {
            // fall through to the cross-file search
          }
          if (token?.isCancellationRequested) {
            return null
          }
        }
        const ctx = hooks.getContext(filePath)
        if (!ctx) {
          return null
        }
        // Single best definition: Orca's standalone Monaco can't preview unopened
        // files in a multi-result peek, so navigate to the top-ranked match.
        const best = (await resolveDefinitions(word, ctx, { fromGrammar, token }))[0]
        if (!best) {
          return null
        }
        const uri = monaco.Uri.parse(best.filePath)
        rememberTarget(uri.toString(), best.filePath)
        return [
          {
            uri,
            range: new monaco.Range(best.line, best.column, best.line, best.column + word.length)
          }
        ]
      }
    })
  )

  // Open a cross-file definition WE produced in Orca's tab system. Same-file
  // jumps and any navigation we didn't produce fall through to Monaco.
  subs.push(
    monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selectionOrPosition) {
        if (source.getModel()?.uri.toString() === resource.toString()) {
          return false
        }
        const filePath = targetPaths.get(resource.toString())
        if (!filePath) {
          return false
        }
        const { line, column } = positionLineColumn(selectionOrPosition)
        hooks.openTarget(filePath, line, column)
        return true
      }
    })
  )

  g.__treeSitterDefs = { dispose: () => subs.forEach((s) => s.dispose()) }
}
