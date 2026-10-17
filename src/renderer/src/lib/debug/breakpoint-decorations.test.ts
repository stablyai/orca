// @vitest-environment happy-dom

import type { editor, IRange } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DebugBreakpointFields,
  DebugBreakpointWire,
  DebugSnapshot
} from '../../../../preload/api/debug-api'
import type { DebugClient } from './debug-client'
import type { DebugEditorBinding, DebugMonaco } from './connect-debug-editor'
import { createDebugSessionStore } from './use-debug-session'
import {
  BREAKPOINT_SYNC_DELAY_MS,
  breakpointGlyphClass,
  installBreakpointDecorations
} from './breakpoint-decorations'
import { installBreakpointEditorInput } from './breakpoint-editor-input'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const FILE = '/repo/src/app.py'
const GLYPH = 2

function fakeCollection() {
  let ranges: IRange[] = []
  const collection = {
    decorations: new Array<editor.IModelDeltaDecoration>(),
    set: vi.fn((decorations: editor.IModelDeltaDecoration[]) => {
      collection.decorations = decorations
      ranges = decorations.map((d) => ({ ...d.range }))
      return decorations.map((_d, i) => `d${i}`)
    }),
    getRanges: () => ranges,
    clear: vi.fn(() => {
      collection.decorations = []
      ranges = []
    }),
    /** What Monaco does to tracked ranges when lines are inserted above them. */
    shift: (fromLine: number, delta: number) => {
      ranges = ranges.map((r) =>
        r.startLineNumber >= fromLine
          ? {
              ...r,
              startLineNumber: r.startLineNumber + delta,
              endLineNumber: r.endLineNumber + delta
            }
          : r
      )
    }
  }
  return collection
}

function fakeEditor(lineCount = 20) {
  const collections: ReturnType<typeof fakeCollection>[] = []
  const content = new Set<(e: editor.IModelContentChangedEvent) => void>()
  const mouse = new Set<(e: editor.IEditorMouseEvent) => void>()
  let fullRange: IRange = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: lineCount,
    endColumn: 10
  }
  const listen =
    <T>(set: Set<T>) =>
    (listener: T) => {
      set.add(listener)
      return { dispose: () => set.delete(listener) }
    }
  const instance = {
    createDecorationsCollection: () => {
      const collection = fakeCollection()
      collections.push(collection)
      return collection
    },
    getModel: () => ({ getFullModelRange: () => fullRange }),
    onDidChangeModelContent: vi.fn(listen(content)),
    onMouseDown: vi.fn(listen(mouse)),
    addAction: vi.fn((action: editor.IActionDescriptor) => ({
      dispose: vi.fn(),
      action
    })),
    addContentWidget: vi.fn(),
    removeContentWidget: vi.fn(),
    getPosition: vi.fn(() => ({ lineNumber: 4, column: 1 })),
    getLayoutInfo: () => ({ contentWidth: 200 }),
    focus: vi.fn()
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every editor member the debug gutter reads.
    editor: instance as unknown as editor.IStandaloneCodeEditor,
    instance,
    collections,
    listenerCount: () => content.size + mouse.size,
    clickGlyph: (lineNumber: number, leftButton = true) =>
      mouse.forEach((listener) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only target.type, target.position and event.leftButton.
        listener({
          target: { type: GLYPH, position: { lineNumber } },
          event: { leftButton }
        } as unknown as editor.IEditorMouseEvent)
      ),
    change: (
      event: { isFlush?: boolean; changes?: { range: IRange }[] },
      nextFullRange = fullRange
    ) => {
      fullRange = nextFullRange
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only isFlush and changes[].range.
      const full = {
        isFlush: false,
        changes: [],
        ...event
      } as unknown as editor.IModelContentChangedEvent
      content.forEach((listener) => listener(full))
    }
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these enum members are read.
const monaco = {
  editor: {
    TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    MouseTargetType: { GUTTER_GLYPH_MARGIN: GLYPH },
    ContentWidgetPositionPreference: { BELOW: 2 }
  }
} as unknown as DebugMonaco

function fakeClient() {
  let breakpoints: DebugBreakpointWire[] = []
  let next = 0
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
  const calls = {
    addBreakpoint: vi.fn((p: { path: string; line: number } & DebugBreakpointFields) => {
      const bp: DebugBreakpointWire = {
        id: `bp${++next}`,
        path: p.path,
        line: p.line,
        enabled: p.enabled ?? true,
        ...(p.condition ? { condition: p.condition } : {}),
        ...(p.logMessage ? { logMessage: p.logMessage } : {}),
        answer: { state: 'verified' }
      }
      breakpoints.push(bp)
      return ok(bp)
    }),
    updateBreakpoint: vi.fn((p: { id: string; fields: DebugBreakpointFields }) => {
      breakpoints = breakpoints.map((bp) => (bp.id === p.id ? { ...bp, ...p.fields } : bp))
      return ok(breakpoints.find((bp) => bp.id === p.id))
    }),
    removeBreakpoint: vi.fn((p: { id: string }) => {
      breakpoints = breakpoints.filter((bp) => bp.id !== p.id)
      return ok(null)
    }),
    setFileLines: vi.fn((p: { lines: { id: string; line: number }[] }) => {
      const moved = new Map(p.lines.map((l) => [l.id, l.line]))
      breakpoints = breakpoints.map((bp) => ({
        ...bp,
        line: moved.get(bp.id) ?? bp.line
      }))
      return ok(breakpoints)
    }),
    listBreakpoints: vi.fn(() => ok(breakpoints.map((bp) => ({ ...bp })))),
    stackTrace: vi.fn(),
    onState: vi.fn(() => () => {}),
    onOutput: vi.fn(() => () => {})
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gutter calls only the methods faked here.
    client: calls as unknown as DebugClient,
    calls,
    lines: () => breakpoints.map((bp) => bp.line)
  }
}

const binding: DebugEditorBinding = {
  target: { repoId: 'r1', worktreePath: '/repo' },
  filePath: FILE,
  getCoreRoot: () => '/repo',
  isThisFile: (path) => path === FILE,
  toEditorPath: (path) => path
}

function setup() {
  const fake = fakeEditor()
  const { client, calls, lines } = fakeClient()
  const sessionStore = createDebugSessionStore(client)
  const controller = installBreakpointDecorations(fake.editor, monaco, binding, {
    client,
    sessionStore
  })
  const collection = fake.collections[0]
  const classes = () => collection.decorations.map((d) => d.options.glyphMarginClassName)
  return { fake, calls, lines, sessionStore, controller, collection, classes }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('breakpoint decorations', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a glyph click adds a breakpoint, a second click removes it', async () => {
    const { fake, calls, collection } = setup()
    fake.clickGlyph(5)
    await settle()
    expect(calls.addBreakpoint).toHaveBeenCalledWith({
      repoId: 'r1',
      worktreePath: '/repo',
      path: FILE,
      line: 5
    })
    expect(collection.getRanges().map((r) => r.startLineNumber)).toEqual([5])
    expect(collection.decorations[0].options.stickiness).toBe(1)

    fake.clickGlyph(5)
    await settle()
    expect(calls.removeBreakpoint).toHaveBeenCalledWith({
      repoId: 'r1',
      worktreePath: '/repo',
      id: 'bp1'
    })
    expect(collection.decorations).toEqual([])
  })

  it('ignores a right click on the glyph margin', async () => {
    const { fake, calls } = setup()
    fake.clickGlyph(5, false)
    await settle()
    expect(calls.addBreakpoint).not.toHaveBeenCalled()
  })

  it('an edit above a breakpoint moves it and sends setFileLines once after the debounce', async () => {
    const { fake, calls, lines, collection, controller } = setup()
    await controller.add(5, { condition: 'x > 1' })
    await settle()
    collection.shift(3, 2)
    fake.change({
      changes: [
        {
          range: {
            startLineNumber: 3,
            startColumn: 1,
            endLineNumber: 3,
            endColumn: 1
          }
        }
      ]
    })
    fake.change({
      changes: [
        {
          range: {
            startLineNumber: 4,
            startColumn: 1,
            endLineNumber: 4,
            endColumn: 1
          }
        }
      ]
    })
    await vi.advanceTimersByTimeAsync(BREAKPOINT_SYNC_DELAY_MS - 1)
    expect(calls.setFileLines).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.setFileLines).toHaveBeenCalledTimes(1)
    expect(calls.setFileLines).toHaveBeenCalledWith({
      repoId: 'r1',
      worktreePath: '/repo',
      path: FILE,
      lines: [{ id: 'bp1', line: 7 }]
    })
    expect(lines()).toEqual([7])
    expect(controller.at(7)?.condition).toBe('x > 1')
  })

  it('a whole-model replacement is not an edit: no sync, stored lines kept', async () => {
    const { fake, calls, lines, collection, controller } = setup()
    await controller.add(5, {})
    await settle()
    // Monaco collapses tracked ranges when every line is replaced.
    collection.shift(1, -4)
    const previous = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 20,
      endColumn: 10
    }
    fake.change({ changes: [{ range: previous }] }, { ...previous, endLineNumber: 30 })
    await vi.advanceTimersByTimeAsync(BREAKPOINT_SYNC_DELAY_MS * 2)
    expect(calls.setFileLines).not.toHaveBeenCalled()
    expect(lines()).toEqual([5])
    expect(collection.getRanges().map((r) => r.startLineNumber)).toEqual([5])

    fake.change({ isFlush: true })
    await vi.advanceTimersByTimeAsync(BREAKPOINT_SYNC_DELAY_MS * 2)
    expect(calls.setFileLines).not.toHaveBeenCalled()
  })

  it('a reload during a pending sync renders the newer snapshot, not the pre-edit list', async () => {
    const { fake, calls, collection, controller, sessionStore } = setup()
    await controller.add(5, {})
    await settle()
    collection.shift(3, 1)
    fake.change({
      changes: [{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 } }]
    })
    sessionStore.ingestSnapshot({
      seq: 9,
      worktreePath: '/repo',
      status: 'running',
      configName: null,
      adapterId: null,
      capabilities: {},
      stopped: null,
      threads: [],
      breakpoints: [
        { id: 'z', path: FILE, line: 12, enabled: true, answer: { state: 'verified' } }
      ],
      exceptionFilters: { available: [], enabled: [] },
      lastError: null
    })
    fake.change({ isFlush: true })
    expect(collection.getRanges().map((r) => r.startLineNumber)).toEqual([12])
    await vi.advanceTimersByTimeAsync(BREAKPOINT_SYNC_DELAY_MS * 2)
    expect(calls.setFileLines).not.toHaveBeenCalled()
    expect(calls.listBreakpoints).toHaveBeenCalled()
  })

  it('renders each breakpoint state with its own class', () => {
    const bp = (over: Partial<DebugBreakpointWire>): DebugBreakpointWire => ({
      id: 'b',
      path: FILE,
      line: 1,
      enabled: true,
      answer: { state: 'verified' },
      ...over
    })
    expect(breakpointGlyphClass(bp({}))).toBe(
      'orca-debug-bp orca-debug-bp-plain orca-debug-bp-verified'
    )
    expect(
      breakpointGlyphClass(bp({ answer: { state: 'pending', message: 'waiting' } }))
    ).toContain('orca-debug-bp-pending')
    expect(breakpointGlyphClass(bp({ answer: { state: 'failed', message: 'no code' } }))).toContain(
      'orca-debug-bp-failed'
    )
    expect(breakpointGlyphClass(bp({ condition: 'x' }))).toContain('orca-debug-bp-conditional')
    expect(breakpointGlyphClass(bp({ logMessage: 'hi {x}' }))).toContain('orca-debug-bp-log')
    expect(breakpointGlyphClass(bp({ enabled: false }))).toContain('orca-debug-bp-disabled')
  })

  it('re-renders when a snapshot brings breakpoints changed elsewhere, with the adapter message as title', () => {
    const { sessionStore, classes, collection } = setup()
    const snapshot: DebugSnapshot = {
      seq: 3,
      worktreePath: '/repo',
      status: 'running',
      configName: null,
      adapterId: null,
      capabilities: {},
      stopped: null,
      threads: [],
      breakpoints: [
        {
          id: 'x',
          path: FILE,
          line: 9,
          enabled: true,
          answer: { state: 'pending', message: 'not sent' }
        },
        {
          id: 'y',
          path: '/repo/other.py',
          line: 2,
          enabled: true,
          answer: { state: 'verified' }
        }
      ],
      exceptionFilters: { available: [], enabled: [] },
      lastError: null
    }
    sessionStore.ingestSnapshot(snapshot)
    expect(classes()).toEqual(['orca-debug-bp orca-debug-bp-plain orca-debug-bp-pending'])
    expect(collection.decorations[0].options.glyphMarginHoverMessage).toEqual({
      value: 'not sent'
    })
  })

  it('dispose removes its listeners and decorations', () => {
    const { fake, controller, collection } = setup()
    expect(fake.listenerCount()).toBe(2)
    controller.dispose()
    expect(fake.listenerCount()).toBe(0)
    expect(collection.clear).toHaveBeenCalled()
  })
})

describe('breakpoint editor input', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function openConditional() {
    const ctx = setup()
    const input = installBreakpointEditorInput(ctx.fake.editor, monaco, ctx.controller)
    const actions = ctx.fake.instance.addAction.mock.calls.map(([action]) => action)
    expect(actions.every((a) => a.contextMenuGroupId === 'debug')).toBe(true)
    void actions.find((a) => a.id === 'orca.debug.addConditionalBreakpoint')?.run(ctx.fake.editor)
    const widget: editor.IContentWidget = ctx.fake.instance.addContentWidget.mock.calls[0][0]
    const field = widget.getDomNode().querySelector('input')
    if (!field) {
      throw new Error('no input')
    }
    return { ...ctx, input, actions, widget, field }
  }

  it('Enter saves a conditional breakpoint at the cursor line and returns focus', async () => {
    const { field, calls, fake, widget } = openConditional()
    expect(widget.getPosition()?.position).toEqual({
      lineNumber: 4,
      column: 1
    })
    field.value = 'count > 3'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    expect(calls.addBreakpoint).toHaveBeenCalledWith(
      expect.objectContaining({ line: 4, condition: 'count > 3' })
    )
    expect(fake.instance.removeContentWidget).toHaveBeenCalledWith(widget)
    expect(fake.instance.focus).toHaveBeenCalled()
  })

  it('Enter that confirms an IME composition does not save', async () => {
    const { field, calls, fake } = openConditional()
    field.value = 'count > 3'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    await settle()
    expect(calls.addBreakpoint).not.toHaveBeenCalled()
    expect(fake.instance.removeContentWidget).not.toHaveBeenCalled()
  })

  it('caps the input to the editor width', () => {
    const { widget } = openConditional()
    expect(widget.getDomNode().style.maxWidth).toBe('176px')
  })

  it('Escape cancels without writing', async () => {
    const { field, calls, fake } = openConditional()
    field.value = 'ignored'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    expect(calls.addBreakpoint).not.toHaveBeenCalled()
    expect(fake.instance.removeContentWidget).toHaveBeenCalled()
    expect(fake.instance.focus).toHaveBeenCalled()
  })

  it('enable/disable and remove act on the breakpoint at the cursor line', async () => {
    const { actions, controller, calls, fake, field } = openConditional()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await controller.add(4, {})
    await settle()
    void actions.find((a) => a.id === 'orca.debug.toggleBreakpointEnabled')?.run(fake.editor)
    await settle()
    expect(calls.updateBreakpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bp1', fields: { enabled: false } })
    )
    void actions.find((a) => a.id === 'orca.debug.removeBreakpoint')?.run(fake.editor)
    await settle()
    expect(calls.removeBreakpoint).toHaveBeenCalledWith(expect.objectContaining({ id: 'bp1' }))
  })
})
