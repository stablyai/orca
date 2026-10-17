import type { editor, IDisposable, IRange } from 'monaco-editor'
import type {
  DebugBreakpointFields,
  DebugBreakpointWire,
  DebugSnapshot
} from '../../../../preload/api/debug-api'
import { translate } from '@/i18n/i18n'
import type { DebugClient } from './debug-client'
import type { DebugSessionStore } from './use-debug-session'
import type { DebugEditorBinding, DebugMonaco } from './connect-debug-editor'
import { DEBUG_GLYPH_CSS } from './stopped-location-decorations'

export const BREAKPOINT_SYNC_DELAY_MS = 300

export type BreakpointController = IDisposable & {
  /** The breakpoint whose decoration currently sits on `line`. */
  at: (line: number) => DebugBreakpointWire | undefined
  toggle: (line: number) => Promise<void>
  add: (line: number, fields: DebugBreakpointFields) => Promise<void>
  update: (id: string, fields: DebugBreakpointFields) => Promise<void>
  remove: (id: string) => Promise<void>
  refresh: () => void
}

type Deps = { client: DebugClient; sessionStore: DebugSessionStore }

const STYLE_ID = 'orca-debug-glyph-styles'

const BREAKPOINT_CSS = `
.monaco-editor .orca-debug-bp::before { content: ''; position: absolute; left: 50%; top: 50%; width: 9px; height: 9px; transform: translate(-50%, -50%); border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--destructive); background: var(--destructive); }
.monaco-editor .orca-debug-bp-conditional::before { background: linear-gradient(var(--destructive) 0 0) center / 5px 1.5px no-repeat, var(--editor-surface); }
.monaco-editor .orca-debug-bp-log::before { border-radius: 1px; width: 8px; height: 8px; transform: translate(-50%, -50%) rotate(45deg); }
.monaco-editor .orca-debug-bp-pending::before { background: transparent; }
.monaco-editor .orca-debug-bp-failed::before { background: transparent; border-color: var(--muted-foreground); }
/* Full-strength muted tone for contrast; the slash tells it apart from the hollow failed ring. */
.monaco-editor .orca-debug-bp-disabled::before { background: linear-gradient(135deg, transparent 40%, var(--editor-surface) 40% 60%, transparent 60%), var(--muted-foreground); border-color: var(--muted-foreground); }
`

/** One style element for every debug glyph, injected on the first editor that connects. */
export function ensureDebugGlyphStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) {
    return
  }
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = BREAKPOINT_CSS + DEBUG_GLYPH_CSS
  doc.head.appendChild(style)
}

export function breakpointGlyphClass(bp: DebugBreakpointWire): string {
  const kind = bp.logMessage
    ? 'orca-debug-bp-log'
    : bp.condition || bp.hitCondition
      ? 'orca-debug-bp-conditional'
      : 'orca-debug-bp-plain'
  const state = !bp.enabled
    ? 'orca-debug-bp-disabled'
    : bp.answer.state === 'verified'
      ? 'orca-debug-bp-verified'
      : bp.answer.state === 'pending'
        ? 'orca-debug-bp-pending'
        : 'orca-debug-bp-failed'
  return `orca-debug-bp ${kind} ${state}`
}

function breakpointTitle(bp: DebugBreakpointWire): string {
  if (bp.enabled && bp.answer.state !== 'verified' && bp.answer.message) {
    return bp.answer.message
  }
  if (bp.logMessage) {
    return translate('debug.breakpoint.logpointTitle', 'Logpoint: {{message}}', {
      message: bp.logMessage
    })
  }
  if (bp.condition) {
    return translate('debug.breakpoint.conditionTitle', 'Breakpoint if {{condition}}', {
      condition: bp.condition
    })
  }
  return bp.enabled
    ? translate('debug.breakpoint.title', 'Breakpoint')
    : translate('debug.breakpoint.disabledTitle', 'Disabled breakpoint')
}

const escapeMarkdown = (text: string): string => text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&')
const lineRange = (line: number): IRange => ({
  startLineNumber: line,
  startColumn: 1,
  endLineNumber: line,
  endColumn: 1
})
const sameRange = (a: IRange, b: IRange): boolean =>
  a.startLineNumber === b.startLineNumber &&
  a.startColumn === b.startColumn &&
  a.endLineNumber === b.endLineNumber &&
  a.endColumn === b.endColumn

/** A disk reload replaces the whole model: that is not an edit, so breakpoints keep their stored lines. */
function isWholeModelReplace(event: editor.IModelContentChangedEvent, previous: IRange): boolean {
  return (
    event.isFlush || (event.changes.length === 1 && sameRange(event.changes[0].range, previous))
  )
}

// Every editor bound to a root refreshes after any of them writes, so split views agree.
const peersByRoot = new Map<string, Set<() => void>>()

export function installBreakpointDecorations(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: DebugMonaco,
  binding: DebugEditorBinding,
  { client, sessionStore }: Deps
): BreakpointController {
  const { target, filePath } = binding
  const collection = editorInstance.createDecorationsCollection()
  const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
  let shown: DebugBreakpointWire[] = []
  let syncTimer: ReturnType<typeof setTimeout> | null = null
  let refreshGeneration = 0
  // Set when a store update arrived while a sync owned the lines.
  let staleWhileSyncing = false
  let lastSnapshot: DebugSnapshot | null = null
  let fullRange = editorInstance.getModel()?.getFullModelRange() ?? lineRange(1)

  function render(all: DebugBreakpointWire[]): void {
    shown = all.filter((bp) => binding.isThisFile(bp.path))
    collection.set(
      shown.map((bp) => ({
        range: lineRange(bp.line),
        options: {
          glyphMarginClassName: breakpointGlyphClass(bp),
          glyphMarginHoverMessage: {
            value: escapeMarkdown(breakpointTitle(bp))
          },
          stickiness
        }
      }))
    )
  }

  // Ranges come back in the order they were set, so index i is shown[i].
  const currentLines = (): number[] => {
    const ranges = collection.getRanges()
    return shown.map((bp, i) => ranges[i]?.startLineNumber ?? bp.line)
  }

  function refresh(): void {
    const generation = ++refreshGeneration
    void client.listBreakpoints(target).then((result) => {
      if (!result.ok || generation !== refreshGeneration) {
        return
      }
      // A pending sync owns the lines until it lands; it refreshes again afterwards.
      if (syncTimer === null) {
        render(result.value)
      } else {
        staleWhileSyncing = true
      }
    })
  }

  const peers = peersByRoot.get(target.worktreePath) ?? new Set<() => void>()
  peersByRoot.set(target.worktreePath, peers)
  peers.add(refresh)
  const notifyPeers = (): void => peers.forEach((peer) => peer())

  async function write(call: () => Promise<{ ok: boolean }>): Promise<void> {
    await call()
    notifyPeers()
  }

  function sync(): void {
    syncTimer = null
    const lines = currentLines()
    if (lines.every((line, i) => line === shown[i].line)) {
      if (staleWhileSyncing) {
        staleWhileSyncing = false
        refresh()
      }
      return
    }
    staleWhileSyncing = false
    void write(() =>
      client.setFileLines({
        ...target,
        path: filePath,
        lines: shown.map((bp, i) => ({ id: bp.id, line: lines[i] }))
      })
    )
  }

  const cancelSync = (): void => {
    if (syncTimer !== null) {
      clearTimeout(syncTimer)
      syncTimer = null
    }
  }

  const contentListener = editorInstance.onDidChangeModelContent((event) => {
    const previous = fullRange
    fullRange = editorInstance.getModel()?.getFullModelRange() ?? fullRange
    if (isWholeModelReplace(event, previous)) {
      cancelSync()
      // A snapshot that landed during the cancelled sync is newer than shown.
      render(staleWhileSyncing && lastSnapshot ? lastSnapshot.breakpoints : shown)
      if (staleWhileSyncing) {
        staleWhileSyncing = false
        refresh()
      }
      return
    }
    cancelSync()
    syncTimer = setTimeout(sync, BREAKPOINT_SYNC_DELAY_MS)
  })

  const mouseListener = editorInstance.onMouseDown((event) => {
    const { type, position } = event.target
    if (
      type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
      position &&
      event.event.leftButton
    ) {
      void controller.toggle(position.lineNumber)
    }
  })

  const unsubscribe = sessionStore.subscribe(() => {
    const coreRoot = binding.getCoreRoot()
    const snapshot = coreRoot === null ? null : sessionStore.getState(coreRoot).snapshot
    if (snapshot && snapshot !== lastSnapshot) {
      lastSnapshot = snapshot
      if (syncTimer === null) {
        render(snapshot.breakpoints)
      } else {
        staleWhileSyncing = true
      }
    }
  })

  const controller: BreakpointController = {
    at: (line) => {
      const lines = currentLines()
      return shown.find((_bp, i) => lines[i] === line)
    },
    toggle: async (line) => {
      const existing = controller.at(line)
      await (existing ? controller.remove(existing.id) : controller.add(line, {}))
    },
    add: (line, fields) =>
      write(() => client.addBreakpoint({ ...target, path: filePath, ...fields, line })),
    update: (id, fields) => write(() => client.updateBreakpoint({ ...target, id, fields })),
    remove: (id) => write(() => client.removeBreakpoint({ ...target, id })),
    refresh,
    dispose: () => {
      cancelSync()
      refreshGeneration++
      contentListener.dispose()
      mouseListener.dispose()
      unsubscribe()
      peers.delete(refresh)
      if (peers.size === 0) {
        peersByRoot.delete(target.worktreePath)
      }
      collection.clear()
    }
  }
  return controller
}
