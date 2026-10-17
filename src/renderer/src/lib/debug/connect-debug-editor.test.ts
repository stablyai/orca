// @vitest-environment happy-dom

import type { editor, languages } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugBreakpointWire, DebugSnapshot } from '../../../../preload/api/debug-api'
import type { DebugClient } from './debug-client'
import { createDebugSessionStore } from './use-debug-session'
import {
  connectDebugEditor,
  createDebugEditorBinding,
  type DebugEditorDeps,
  type DebugMonaco
} from './connect-debug-editor'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ openFiles: [] }) } }))

const FILE = '/repo/src/app.py'
const CORE_FILE = '/real/repo/src/app.py'

function snapshot(seq: number, breakpoints: DebugBreakpointWire[] = []): DebugSnapshot {
  return {
    seq,
    worktreePath: '/real/repo',
    status: 'stopped',
    configName: 'Run',
    adapterId: 'debugpy',
    capabilities: { supportsEvaluateForHovers: true },
    stopped: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true },
    threads: [{ id: 1, name: 'main' }],
    breakpoints,
    exceptionFilters: { available: [], enabled: [] },
    lastError: null
  }
}

const breakpoint = (line: number): DebugBreakpointWire => ({
  id: `bp${line}`,
  path: CORE_FILE,
  line,
  enabled: true,
  answer: { state: 'verified' }
})

function fakeEditor() {
  const listeners = new Set<unknown>()
  const listen = (listener: unknown) => {
    listeners.add(listener)
    return { dispose: () => listeners.delete(listener) }
  }
  const collections: { set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }[] = []
  const actions: { dispose: ReturnType<typeof vi.fn> }[] = []
  const model = {
    uri: { toString: () => 'file:///repo/src/app.py' },
    getLanguageId: () => 'python',
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 40,
      endColumn: 1
    }),
    getLineContent: () => 'value'
  }
  const instance = {
    getModel: () => model,
    createDecorationsCollection: () => {
      let ranges: unknown[] = []
      const collection = {
        set: vi.fn((next: editor.IModelDeltaDecoration[]) => {
          ranges = next.map((d) => d.range)
        }),
        getRanges: () => ranges,
        clear: vi.fn()
      }
      collections.push(collection)
      return collection
    },
    onDidChangeModelContent: listen,
    onMouseDown: listen,
    addAction: () => {
      const action = { dispose: vi.fn() }
      actions.push(action)
      return action
    },
    revealLineInCenterIfOutsideViewport: vi.fn()
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every editor member connectDebugEditor reads.
    editor: instance as unknown as editor.IStandaloneCodeEditor,
    model,
    listeners,
    collections,
    actions
  }
}

const open: { dispose: () => void }[] = []

function setup() {
  const fake = fakeEditor()
  const providers: languages.HoverProvider[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these enum members and registerHoverProvider are read.
  const monaco = {
    editor: {
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      ContentWidgetPositionPreference: { BELOW: 2 }
    },
    languages: {
      registerHoverProvider: (_language: string, provider: languages.HoverProvider) => {
        providers.push(provider)
        return { dispose: () => {} }
      }
    }
  } as unknown as DebugMonaco
  const calls = {
    snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot(1) })),
    listBreakpoints: vi.fn(async () => ({ ok: true as const, value: [breakpoint(6)] })),
    evaluate: vi.fn(async () => ({
      ok: true as const,
      value: { result: '7', variablesReference: 0 }
    })),
    stackTrace: vi.fn(async () => ({
      ok: true as const,
      value: {
        stackFrames: [{ id: 0, name: 'main', source: { path: CORE_FILE }, line: 6, column: 1 }]
      }
    })),
    onState: () => () => {},
    onOutput: () => () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectDebugEditor calls only the methods faked here.
  const client = calls as unknown as DebugClient
  const sessionStore = createDebugSessionStore(client)
  const deps: Partial<DebugEditorDeps> = {
    client,
    sessionStore,
    resolveContext: (_id, filePath) => ({ repoId: 'r1', rootPath: '/repo', filePath }),
    reveal: { isOpen: () => true, open: vi.fn() }
  }
  const connection = connectDebugEditor(
    fake.editor,
    monaco,
    { filePath: FILE, worktreeId: 'r1::/repo' },
    deps
  )
  open.push(connection)
  const hover = () =>
    providers[0]?.provideHover(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider reads only uri and getLineContent.
      fake.model as unknown as editor.ITextModel,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider reads only lineNumber and column.
      { lineNumber: 1, column: 2 } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider never reads the token.
      {} as never
    )
  return { fake, calls, sessionStore, connection, hover, providers }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('connectDebugEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.head.innerHTML = ''
  })
  afterEach(() => {
    open.splice(0).forEach((connection) => connection.dispose())
    vi.useRealTimers()
  })

  it('learns core’s realpath and renders breakpoints, the stopped line and hover for it', async () => {
    const { fake, calls, hover } = setup()
    await settle()
    expect(calls.snapshot).toHaveBeenCalledWith({ repoId: 'r1', worktreePath: '/repo' })
    expect(calls.listBreakpoints).toHaveBeenCalledWith({ repoId: 'r1', worktreePath: '/repo' })
    const [breakpoints, stopped] = fake.collections
    expect(breakpoints.set.mock.calls.at(-1)?.[0]).toHaveLength(1)
    expect(stopped.set.mock.calls.at(-1)?.[0][0].options.className).toBe('orca-debug-stopped-line')
    expect(document.querySelectorAll('#orca-debug-glyph-styles')).toHaveLength(1)
    expect(fake.actions).toHaveLength(5)
    await expect(hover()).resolves.toMatchObject({
      contents: [{ value: expect.stringContaining('7') }]
    })
  })

  it('injects the glyph styles once across editors', async () => {
    setup()
    setup()
    await settle()
    expect(document.querySelectorAll('#orca-debug-glyph-styles')).toHaveLength(1)
  })

  it('dispose removes every listener, decoration, action and hover mapping', async () => {
    const { fake, connection, sessionStore, hover } = setup()
    await settle()
    expect(fake.listeners.size).toBe(2)
    connection.dispose()
    expect(fake.listeners.size).toBe(0)
    fake.collections.forEach((collection) => expect(collection.clear).toHaveBeenCalled())
    fake.actions.forEach((action) => expect(action.dispose).toHaveBeenCalled())
    await expect(hover()).resolves.toBeNull()

    const setCounts = fake.collections.map((c) => c.set.mock.calls.length)
    sessionStore.ingestSnapshot(snapshot(5, [breakpoint(9)]))
    await settle()
    expect(fake.collections.map((c) => c.set.mock.calls.length)).toEqual(setCounts)
  })

  it('is inert when the editor has no debug context', () => {
    const fake = fakeEditor()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: nothing on monaco is read without a context.
    const noMonaco = {} as DebugMonaco
    const connection = connectDebugEditor(
      fake.editor,
      noMonaco,
      { filePath: FILE, worktreeId: '' },
      {
        resolveContext: () => null
      }
    )
    expect(fake.listeners.size).toBe(0)
    connection.dispose()
  })
})

describe('createDebugEditorBinding', () => {
  it('maps core realpaths onto the editor’s spelling', () => {
    let coreRoot: string | null = null
    const binding = createDebugEditorBinding(
      { repoId: 'r1', rootPath: '/repo', filePath: FILE },
      () => coreRoot
    )
    expect(binding.isThisFile(CORE_FILE)).toBe(false)
    coreRoot = '/real/repo'
    expect(binding.isThisFile(CORE_FILE)).toBe(true)
    expect(binding.isThisFile(FILE)).toBe(true)
    expect(binding.isThisFile('/real/repo/src/other.py')).toBe(false)
    expect(binding.toEditorPath('/real/repo/src/other.py')).toBe('/repo/src/other.py')
    expect(binding.toEditorPath('/elsewhere/x.py')).toBe('/elsewhere/x.py')
  })
})
