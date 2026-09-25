// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'

// The document-sync bridge must not pull the real zustand store into a unit
// test; the owner lookup seam is what varies here.
const openFilesState = vi.hoisted(() => ({
  openFiles: [] as Record<string, unknown>[],
  allWorktrees: [] as { id: string; path: string }[]
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openFiles: openFilesState.openFiles,
      allWorktrees: () => openFilesState.allWorktrees
    })
  }
}))

import { installLanguageServerDocumentSync } from './language-server-document-sync'
import type { LanguageServerDocumentChange } from '../../../../../shared/language-server-navigation-types'

type FakeModel = {
  uri: { scheme: string; fsPath: string }
  languageId: string
  value: string
  changeListeners: ((event: { changes: FakeChange[] }) => void)[]
  disposeListeners: (() => void)[]
  getLanguageId: () => string
  getValue: () => string
  onDidChangeContent: (listener: (event: { changes: FakeChange[] }) => void) => {
    dispose: () => void
  }
  onWillDispose: (listener: () => void) => { dispose: () => void }
}

type FakeChange = {
  range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
  rangeLength?: number
  text: string
}

function makeModel(fsPath: string, languageId = 'cpp', value = 'int main() {}'): FakeModel {
  const model: FakeModel = {
    uri: { scheme: 'file', fsPath },
    languageId,
    value,
    changeListeners: [],
    disposeListeners: [],
    getLanguageId: () => model.languageId,
    getValue: () => model.value,
    onDidChangeContent: (listener) => {
      model.changeListeners.push(listener)
      return {
        dispose: () => {
          model.changeListeners = model.changeListeners.filter((entry) => entry !== listener)
        }
      }
    },
    onWillDispose: (listener) => {
      model.disposeListeners.push(listener)
      return {
        dispose: () => {
          model.disposeListeners = model.disposeListeners.filter((entry) => entry !== listener)
        }
      }
    }
  }
  return model
}

function makeMonaco(models: FakeModel[]): {
  monaco: typeof Monaco
  createdHandlers: ((model: FakeModel) => void)[]
} {
  const createdHandlers: ((model: FakeModel) => void)[] = []
  const monaco = {
    editor: {
      getModels: () => models,
      onDidCreateModel: (handler: (model: FakeModel) => void) => {
        createdHandlers.push(handler)
        return { dispose: () => {} }
      }
    }
  } as unknown as typeof Monaco
  return { monaco, createdHandlers }
}

type RecordedCall =
  | {
      kind: 'open'
      worktreeRoot: string
      filePath: string
      text: string
      connectionId: string | null
    }
  | {
      kind: 'change'
      filePath: string
      version: number
      changes: readonly LanguageServerDocumentChange[]
    }
  | { kind: 'close'; filePath: string }

function installApiRecorder(): RecordedCall[] {
  const calls: RecordedCall[] = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      languageServers: {
        openDocument: async (args: {
          worktreeRoot: string
          filePath: string
          text: string
          connectionId?: string | null
        }) => {
          calls.push({ kind: 'open', ...args, connectionId: args.connectionId ?? null })
          return { ok: true as const }
        },
        changeDocument: async (args: {
          filePath: string
          version: number
          changes: readonly LanguageServerDocumentChange[]
        }) => {
          calls.push({ kind: 'change', ...args })
          return { ok: true as const, version: args.version }
        },
        closeDocument: async (args: { filePath: string }) => {
          calls.push({ kind: 'close', ...args })
          return { ok: true as const }
        }
      }
    }
  })
  return calls
}

/** IPC calls ride a per-model promise pipeline; let queued microtasks run. */
async function flushPipeline(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function setOwner(filePath: string, worktreeId = 'wt-1', worktreeRoot = 'D:\\repo'): void {
  openFilesState.openFiles = [
    {
      filePath,
      relativePath: 'src/a.cpp',
      worktreeId,
      mode: 'edit',
      runtimeEnvironmentId: null
    }
  ]
  openFilesState.allWorktrees = [{ id: worktreeId, path: worktreeRoot }]
}

beforeEach(() => {
  vi.clearAllMocks()
  openFilesState.openFiles = []
  openFilesState.allWorktrees = []
})

describe('installLanguageServerDocumentSync', () => {
  it('didOpens a new C++ model with its owning worktree root and the MODEL text', async () => {
    const calls = installApiRecorder()
    setOwner('D:\\repo\\src\\a.cpp')
    const model = makeModel('d:\\repo\\src\\a.cpp', 'cpp', 'model text')
    const { monaco, createdHandlers } = makeMonaco([])
    installLanguageServerDocumentSync(monaco)

    createdHandlers[0]?.(model)
    await flushPipeline()
    expect(calls).toEqual([
      {
        kind: 'open',
        worktreeRoot: 'D:\\repo',
        filePath: 'D:\\repo\\src\\a.cpp',
        text: 'model text',
        connectionId: null
      }
    ])
  })

  it('ignores non-file models, non-C/C++ languages and unowned documents', async () => {
    const calls = installApiRecorder()
    const { monaco, createdHandlers } = makeMonaco([])
    installLanguageServerDocumentSync(monaco)

    createdHandlers[0]?.(makeModel('d:\\repo\\src\\a.cpp', 'typescript'))
    createdHandlers[0]?.(makeModel('d:\\repo\\src\\a.cpp', 'cpp')) // no owner in store yet
    expect(calls).toEqual([])

    setOwner('D:\\repo\\src\\a.cpp')
    createdHandlers[0]?.(makeModel('inmemory:model', 'cpp'))
    await flushPipeline()
    expect(calls).toEqual([])
  })

  it('ignores remote-runtime and SSH-external owners (native host only in S1)', () => {
    const calls = installApiRecorder()
    openFilesState.openFiles = [
      {
        filePath: 'D:\\repo\\src\\a.cpp',
        worktreeId: 'wt-1',
        mode: 'edit',
        runtimeEnvironmentId: 'runtime-9'
      }
    ]
    openFilesState.allWorktrees = [{ id: 'wt-1', path: 'D:\\repo' }]
    const { monaco, createdHandlers } = makeMonaco([])
    installLanguageServerDocumentSync(monaco)
    createdHandlers[0]?.(makeModel('D:\\repo\\src\\a.cpp'))
    expect(calls).toEqual([])
  })

  it('translates change events to 0-based ranges with a monotonically increasing version', async () => {
    const calls = installApiRecorder()
    setOwner('D:\\repo\\src\\a.cpp')
    const model = makeModel('D:\\repo\\src\\a.cpp')
    const { monaco, createdHandlers } = makeMonaco([])
    installLanguageServerDocumentSync(monaco)
    createdHandlers[0]?.(model)

    model.changeListeners[0]?.({
      changes: [
        {
          range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 9 },
          rangeLength: 4,
          text: 'Timer'
        }
      ]
    })
    model.changeListeners[0]?.({
      changes: [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
          text: '\n'
        }
      ]
    })
    await flushPipeline()
    expect(calls.filter((call) => call.kind === 'change')).toEqual([
      {
        kind: 'change',
        filePath: 'D:\\repo\\src\\a.cpp',
        version: 2,
        changes: [
          {
            range: { startLine: 2, startCharacter: 4, endLine: 2, endCharacter: 8 },
            rangeLength: 4,
            text: 'Timer'
          }
        ]
      },
      {
        kind: 'change',
        filePath: 'D:\\repo\\src\\a.cpp',
        version: 3,
        changes: [
          {
            range: { startLine: 0, startCharacter: 0, endLine: 1, endCharacter: 0 },
            rangeLength: undefined,
            text: '\n'
          }
        ]
      }
    ])
  })

  it('sends didClose on model disposal and does not double-track a path', async () => {
    const calls = installApiRecorder()
    setOwner('D:\\repo\\src\\a.cpp')
    const model = makeModel('D:\\repo\\src\\a.cpp')
    const { monaco, createdHandlers } = makeMonaco([])
    installLanguageServerDocumentSync(monaco)
    createdHandlers[0]?.(model)
    // A second model for the same path is ignored (monaco keys models by uri,
    // but the guard makes the bridge safe against duplicate events).
    createdHandlers[0]?.(makeModel('D:\\repo\\src\\a.cpp'))
    await flushPipeline()
    expect(calls.filter((call) => call.kind === 'open')).toHaveLength(1)

    for (const listener of model.disposeListeners) {
      listener()
    }
    await flushPipeline()
    expect(calls).toContainEqual({ kind: 'close', filePath: 'D:\\repo\\src\\a.cpp' })
  })

  it('sweeps already-existing models at install time', async () => {
    const calls = installApiRecorder()
    setOwner('D:\\repo\\src\\a.cpp')
    const existing = makeModel('D:\\repo\\src\\a.cpp')
    const { monaco } = makeMonaco([existing])
    installLanguageServerDocumentSync(monaco)
    await flushPipeline()
    expect(calls).toEqual([
      {
        kind: 'open',
        worktreeRoot: 'D:\\repo',
        filePath: 'D:\\repo\\src\\a.cpp',
        text: 'int main() {}',
        connectionId: null
      }
    ])
  })
})
