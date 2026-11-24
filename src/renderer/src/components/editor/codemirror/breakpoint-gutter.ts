import {
  Annotation,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import {
  breakpointsLinesChanged,
  mapBreakpointsThroughChanges
} from '@/store/debug/debug-value-format'
import {
  useDebugSessionStore,
  type DebugBreakpoint,
  type DebugBreakpointState
} from '@/store/debug/use-debug-session-store'

export const externalSyncAnnotation = Annotation.define<boolean>()

export type BreakpointPopoverRequest = {
  filePath: string
  line: number
  x: number
  y: number
  focusLog?: boolean
}

type BreakpointLook =
  | 'normal'
  | 'verified'
  | 'unverified'
  | 'disabled'
  | 'muted'
  | 'conditional'
  | 'log'

const DISABLED_LOOKS = new Set<BreakpointLook>(['disabled', 'muted'])

function resolveBreakpointLook(
  bp: DebugBreakpoint,
  bpState: DebugBreakpointState | undefined,
  muted: boolean,
  activeSession: boolean
): BreakpointLook {
  if (!bp.enabled) {
    return 'disabled'
  }
  if (muted) {
    return 'muted'
  }
  if (activeSession && bpState && !bpState.verified) {
    return 'unverified'
  }
  if (bp.logMessage?.trim()) {
    return 'log'
  }
  if (bp.condition?.trim() || bp.hitCondition?.trim()) {
    return 'conditional'
  }
  return activeSession && bpState?.verified ? 'verified' : 'normal'
}

function breakpointTooltip(bp: DebugBreakpoint, bpState: DebugBreakpointState | undefined): string {
  const parts: string[] = []
  if (bpState?.message) {
    parts.push(bpState.message)
  }
  if (bp.condition?.trim()) {
    parts.push(`if (${bp.condition.trim()})`)
  }
  if (bp.hitCondition?.trim()) {
    parts.push(`hit ${bp.hitCondition.trim()}`)
  }
  if (bp.logMessage?.trim()) {
    parts.push(`log: ${bp.logMessage.trim()}`)
  }
  return parts.join(' | ')
}

class BreakpointMarker extends GutterMarker {
  constructor(
    readonly look: BreakpointLook,
    readonly hint: string
  ) {
    super()
  }

  eq(other: BreakpointMarker): boolean {
    return other.look === this.look && other.hint === this.hint
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-debug-bp-dot cm-debug-bp-${this.look}`
    if (this.hint) {
      el.title = this.hint
    }
    return el
  }
}

const bpLineDecoration = Decoration.line({ class: 'cm-debug-bp-line' })
const setMarkersEffect = StateEffect.define<RangeSet<BreakpointMarker>>()

function buildMarkers(state: EditorState, fileKey: string): RangeSet<BreakpointMarker> {
  const dbg = useDebugSessionStore.getState()
  const bps = dbg.breakpointsByFile[fileKey] ?? []
  const states = dbg.breakpointStatesByFile[fileKey] ?? []
  const stateByLine = new Map(states.map((st) => [st.line, st]))
  const activeSession =
    dbg.status === 'starting' || dbg.status === 'running' || dbg.status === 'stopped'
  const ranges: Range<BreakpointMarker>[] = []
  const sorted = [...bps].sort((a, b) => a.line - b.line)
  for (const bp of sorted) {
    if (bp.line < 1 || bp.line > state.doc.lines) {
      continue
    }
    const bpState = stateByLine.get(bp.line)
    const look = resolveBreakpointLook(bp, bpState, dbg.breakpointsMuted, activeSession)
    const marker = new BreakpointMarker(look, breakpointTooltip(bp, bpState))
    ranges.push(marker.range(state.doc.line(bp.line).from))
  }
  return RangeSet.of(ranges, true)
}

function buildLineDecorations(markers: RangeSet<BreakpointMarker>): DecorationSet {
  const lines: Range<Decoration>[] = []
  for (const it = markers.iter(); it.value; it.next()) {
    if (!DISABLED_LOOKS.has(it.value.look)) {
      lines.push(bpLineDecoration.range(it.from))
    }
  }
  return Decoration.set(lines, true)
}

export function createDebugGutterExtension(
  filePath: string,
  fileKey: string,
  onOpenPopover: (req: BreakpointPopoverRequest) => void
): Extension {
  const markerField = StateField.define<RangeSet<BreakpointMarker>>({
    create: (state) => buildMarkers(state, fileKey),
    update(markers, tr) {
      for (const e of tr.effects) {
        if (e.is(setMarkersEffect)) {
          return e.value
        }
      }
      return tr.docChanged ? markers.map(tr.changes) : markers
    },
    provide: (f) => EditorView.decorations.from(f, buildLineDecorations)
  })

  const syncPlugin = ViewPlugin.fromClass(
    class {
      private unsub: () => void
      private pending = false
      private destroyed = false

      constructor(readonly view: EditorView) {
        this.unsub = useDebugSessionStore.subscribe((s, prev) => {
          const prevActive = prev.status === 'running' || prev.status === 'stopped'
          const nextActive = s.status === 'running' || s.status === 'stopped'
          if (
            s.breakpointsByFile[fileKey] !== prev.breakpointsByFile[fileKey] ||
            s.breakpointStatesByFile[fileKey] !== prev.breakpointStatesByFile[fileKey] ||
            s.breakpointsMuted !== prev.breakpointsMuted ||
            prevActive !== nextActive
          ) {
            this.scheduleRebuild()
          }
        })
      }

      scheduleRebuild(): void {
        if (this.pending) {
          return
        }
        this.pending = true
        queueMicrotask(() => {
          this.pending = false
          if (this.destroyed) {
            return
          }
          const next = buildMarkers(this.view.state, fileKey)
          const current = this.view.state.field(markerField)
          if (!RangeSet.eq([current], [next])) {
            this.view.dispatch({ effects: setMarkersEffect.of(next) })
          }
        })
      }

      update(u: ViewUpdate): void {
        if (!u.docChanged) {
          return
        }
        const fromPropSync = u.transactions.some((tr) => tr.annotation(externalSyncAnnotation))
        if (fromPropSync) {
          this.scheduleRebuild()
          return
        }
        const dbg = useDebugSessionStore.getState()
        const current = dbg.breakpointsByFile[fileKey]
        if (!current || current.length === 0) {
          return
        }
        const mapped = mapBreakpointsThroughChanges(
          current,
          u.startState.doc,
          u.changes,
          u.state.doc
        )
        if (breakpointsLinesChanged(current, mapped)) {
          dbg.remapFileBreakpoints(filePath, mapped)
        }
      }

      destroy(): void {
        this.destroyed = true
        this.unsub()
      }
    }
  )

  const bpGutter = gutter({
    class: 'cm-debug-breakpoint-gutter',
    markers: (view) => view.state.field(markerField),
    initialSpacer: () => new BreakpointMarker('normal', ''),
    domEventHandlers: {
      mousedown(view, line, event) {
        if (!(event instanceof MouseEvent)) {
          return false
        }
        const lineNum = view.state.doc.lineAt(line.from).number
        const dbg = useDebugSessionStore.getState()
        const existing = dbg.breakpointsByFile[fileKey]?.find((b) => b.line === lineNum)
        if (event.button === 1) {
          if (!existing) {
            return false
          }
          event.preventDefault()
          void dbg.updateBreakpoint(filePath, lineNum, { enabled: !existing.enabled })
          return true
        }
        if (event.button !== 0) {
          return false
        }
        event.preventDefault()
        if (!existing && event.shiftKey) {
          void dbg.toggleBreakpoint(filePath, lineNum)
          onOpenPopover({
            filePath,
            line: lineNum,
            x: event.clientX,
            y: event.clientY,
            focusLog: true
          })
          return true
        }
        void dbg.toggleBreakpoint(filePath, lineNum)
        return true
      },
      contextmenu(view, line, event) {
        if (!(event instanceof MouseEvent)) {
          return false
        }
        event.preventDefault()
        const lineNum = view.state.doc.lineAt(line.from).number
        const dbg = useDebugSessionStore.getState()
        const existing = dbg.breakpointsByFile[fileKey]?.find((b) => b.line === lineNum)
        if (!existing) {
          void dbg.toggleBreakpoint(filePath, lineNum)
        }
        onOpenPopover({ filePath, line: lineNum, x: event.clientX, y: event.clientY })
        return true
      }
    }
  })

  return [markerField, syncPlugin, bpGutter]
}
