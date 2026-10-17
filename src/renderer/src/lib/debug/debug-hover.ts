import type { editor, IDisposable, IRange, languages, Position } from 'monaco-editor'
import type { DebugClient } from './debug-client'
import type { DebugSessionStore } from './use-debug-session'
import type { DebugEditorBinding, DebugMonaco } from './connect-debug-editor'

const IDENTIFIER = /[A-Za-z_$][\w$]*/y
const CHAIN = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\[[^[\]()]*\])*/g
// Identifiers joined by `.` or a literal/identifier index; no call parentheses, so nothing runs.
const SAFE_EXPRESSION =
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|'[^'()\\]*'|"[^"()\\]*"|[A-Za-z_$][\w$]*)\])*$/

/** The member chain ending at the identifier under `column` (1-based), e.g. `a.b` when hovering `b` in `a.b.c`. */
export function hoverExpressionAt(
  line: string,
  column: number
): { expression: string; startColumn: number; endColumn: number } | null {
  const offset = column - 1
  for (const match of line.matchAll(CHAIN)) {
    const start = match.index
    if (offset < start || offset >= start + match[0].length) {
      continue
    }
    // A member of a call or index result (`f().x`) has no side-effect-free receiver.
    if (/[.)\]]\s*$/.test(line.slice(0, start))) {
      return null
    }
    let wordStart = offset
    while (wordStart > start && /[\w$]/.test(line[wordStart - 1])) {
      wordStart--
    }
    IDENTIFIER.lastIndex = wordStart
    const word = IDENTIFIER.exec(line)
    if (!word || offset >= wordStart + word[0].length) {
      return null
    }
    const end = wordStart + word[0].length
    const chain = line.slice(start, end).replace(/\s+/g, '')
    // A word inside an index (`i` in `a[i]`) evaluates on its own.
    const [expression, from] = SAFE_EXPRESSION.test(chain) ? [chain, start] : [word[0], wordStart]
    return SAFE_EXPRESSION.test(expression)
      ? { expression, startColumn: from + 1, endColumn: end + 1 }
      : null
  }
  return null
}

// The provider is global per language; each model maps back to the editor that registered it.
const bindingsByModel = new Map<string, DebugEditorBinding[]>()

export function registerDebugHoverModel(uri: string, binding: DebugEditorBinding): IDisposable {
  bindingsByModel.set(uri, [...(bindingsByModel.get(uri) ?? []), binding])
  return {
    dispose: () => {
      const rest = (bindingsByModel.get(uri) ?? []).filter((b) => b !== binding)
      if (rest.length > 0) {
        bindingsByModel.set(uri, rest)
      } else {
        bindingsByModel.delete(uri)
      }
    }
  }
}

export async function provideDebugHover(
  model: { uri: { toString: () => string } } & Pick<editor.ITextModel, 'getLineContent'>,
  position: Pick<Position, 'lineNumber' | 'column'>,
  sessionStore: DebugSessionStore,
  client: Pick<DebugClient, 'evaluate'>
): Promise<languages.Hover | null> {
  const binding = bindingsByModel.get(model.uri.toString())?.[0]
  const coreRoot = binding?.getCoreRoot() ?? null
  if (!binding || coreRoot === null) {
    return null
  }
  const { snapshot, selectedFrameId } = sessionStore.getState(coreRoot)
  if (
    !snapshot?.stopped ||
    snapshot.capabilities.supportsEvaluateForHovers !== true ||
    selectedFrameId === null
  ) {
    return null
  }
  const found = hoverExpressionAt(model.getLineContent(position.lineNumber), position.column)
  if (!found) {
    return null
  }
  const result = await client.evaluate({
    ...binding.target,
    expression: found.expression,
    frameId: selectedFrameId,
    context: 'hover'
  })
  if (!result.ok) {
    return null
  }
  const range: IRange = {
    startLineNumber: position.lineNumber,
    startColumn: found.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: found.endColumn
  }
  // CommonMark: a fence longer than any backtick run inside it cannot be closed early.
  const longestRun = Math.max(
    0,
    ...(result.value.result.match(/`+/g) ?? []).map((run) => run.length)
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return {
    range,
    contents: [{ value: `${fence}text\n${result.value.result}\n${fence}`, isTrusted: false }]
  }
}

const languagesByMonaco = new WeakMap<DebugMonaco, Set<string>>()

/** Registers the hover provider once per language for this Monaco instance; it lives as long as Monaco. */
export function ensureDebugHoverProvider(
  monaco: DebugMonaco,
  languageId: string,
  sessionStore: DebugSessionStore,
  client: Pick<DebugClient, 'evaluate'>
): void {
  const registered = languagesByMonaco.get(monaco) ?? new Set<string>()
  languagesByMonaco.set(monaco, registered)
  if (registered.has(languageId)) {
    return
  }
  registered.add(languageId)
  monaco.languages.registerHoverProvider(languageId, {
    provideHover: (model, position) => provideDebugHover(model, position, sessionStore, client)
  })
}
