// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'

type OpenFileCall = {
  file: Record<string, unknown>
  options: Record<string, unknown> | undefined
}

const storeState = vi.hoisted(() => ({
  openFiles: [] as Record<string, unknown>[],
  allWorktrees: [] as { id: string; path: string }[],
  activeWorktreeId: 'wt-1' as string | null,
  openFileCalls: [] as OpenFileCall[],
  reveals: [] as (Record<string, unknown> | null)[],
  activationCalls: [] as { worktreeId: string }[]
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openFiles: storeState.openFiles,
      activeWorktreeId: storeState.activeWorktreeId,
      allWorktrees: () => storeState.allWorktrees,
      openFile: (file: Record<string, unknown>, options?: Record<string, unknown>) => {
        storeState.openFileCalls.push({ file, options })
        return `tab-${storeState.openFileCalls.length}`
      },
      setPendingEditorReveal: (reveal: Record<string, unknown> | null) => {
        storeState.reveals.push(reveal)
      }
    })
  }
}))

const terminalLinks = vi.hoisted(() => ({
  isPathInsideWorktree: vi.fn<(filePath: string, worktreePath: string) => boolean>(),
  toWorktreeRelativePath: vi.fn<(filePath: string, worktreePath: string) => string | null>()
}))
vi.mock('@/lib/terminal-links', () => terminalLinks)

const worktreeActivation = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<(worktreeId: string, opts?: unknown) => void>()
}))
vi.mock('@/lib/worktree-activation', () => worktreeActivation)

import { installLanguageServerNavigationProviders } from './language-server-navigation-providers'

type Captured = {
  definitionProviders: {
    provideDefinition: (model: unknown, position: unknown) => Promise<unknown>
  }[]
  hoverProviders: { provideHover: (model: unknown, position: unknown) => Promise<unknown> }[]
  openers: {
    openCodeEditor: (source: unknown, resource: unknown, selection: unknown) => Promise<boolean>
  }[]
}

function installWithFakeMonaco(): Captured {
  const captured: Captured = {
    definitionProviders: [],
    hoverProviders: [],
    openers: []
  }
  const monaco = {
    languages: {
      registerDefinitionProvider: (
        _selector: unknown,
        provider: Captured['definitionProviders'][number]
      ) => {
        captured.definitionProviders.push(provider)
        return { dispose: () => {} }
      },
      registerHoverProvider: (_selector: unknown, provider: Captured['hoverProviders'][number]) => {
        captured.hoverProviders.push(provider)
        return { dispose: () => {} }
      }
    },
    editor: {
      registerEditorOpener: (opener: Captured['openers'][number]) => {
        captured.openers.push(opener)
        return { dispose: () => {} }
      }
    },
    Uri: {
      parse: (value: string) => ({ toString: () => value })
    }
  } as unknown as typeof Monaco
  installLanguageServerNavigationProviders(monaco)
  return captured
}

type ApiState = {
  definitionResult: { ok: boolean; locations?: { path: string; range: Record<string, number> }[] }
  hoverResult: { ok: boolean; hover: { kind: string; value: string } | null }
  authorized: string[]
  definitionArgs: unknown[]
  hoverArgs: unknown[]
}

function installApi(state: ApiState): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      languageServers: {
        definition: async (args: unknown) => {
          state.definitionArgs.push(args)
          return state.definitionResult
        },
        hover: async (args: unknown) => {
          state.hoverArgs.push(args)
          return state.hoverResult
        }
      },
      fs: {
        authorizeExternalPath: async ({ targetPath }: { targetPath: string }) => {
          state.authorized.push(targetPath)
        }
      }
    }
  })
}

function makeModel(
  fsPath: string,
  languageId = 'cpp'
): {
  model: unknown
  source: { getModel: () => unknown }
} {
  const model = {
    uri: { scheme: 'file', fsPath },
    getLanguageId: () => languageId,
    getWordAtPosition: () => ({ startColumn: 5, endColumn: 11 })
  }
  return { model, source: { getModel: () => model } }
}

function setOwner(filePath: string, worktreeRoot = 'D:\\repo'): void {
  storeState.openFiles = [
    {
      filePath,
      relativePath: 'src/a.cpp',
      worktreeId: 'wt-1',
      mode: 'edit',
      runtimeEnvironmentId: null
    }
  ]
  storeState.allWorktrees = [{ id: 'wt-1', path: worktreeRoot }]
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.openFiles = []
  storeState.allWorktrees = []
  storeState.activeWorktreeId = 'wt-1'
  storeState.openFileCalls = []
  storeState.reveals = []
  storeState.activationCalls = []
})

describe('definition provider', () => {
  it('queries with a 0-based position and maps the first location to a model uri + range', async () => {
    const apiState: ApiState = {
      definitionResult: {
        ok: true,
        locations: [
          {
            path: 'D:\\repo\\include\\timer.hpp',
            range: { startLine: 39, startCharacter: 8, endLine: 39, endCharacter: 22 }
          }
        ]
      },
      hoverResult: { ok: true, hover: null },
      authorized: [],
      definitionArgs: [],
      hoverArgs: []
    }
    installApi(apiState)
    setOwner('D:\\repo\\src\\a.cpp')
    const captured = installWithFakeMonaco()
    const { model } = makeModel('D:\\repo\\src\\a.cpp')

    const result = (await captured.definitionProviders[0]?.provideDefinition(model, {
      lineNumber: 4,
      column: 7
    })) as { uri: { toString: () => string }; range: Record<string, number> }

    expect(apiState.definitionArgs[0]).toEqual({
      filePath: 'D:\\repo\\src\\a.cpp',
      position: { line: 3, character: 6 }
    })
    expect(result.uri.toString()).toMatch(/file:\/\//)
    expect(result.range).toEqual({
      startLineNumber: 40,
      startColumn: 9,
      endLineNumber: 40,
      endColumn: 23
    })
  })
})

describe('hover provider', () => {
  it('returns markdown contents with the hovered word range', async () => {
    const apiState: ApiState = {
      definitionResult: { ok: true, locations: [] },
      hoverResult: { ok: true, hover: { kind: 'markdown', value: '### method `GetTime`' } },
      authorized: [],
      definitionArgs: [],
      hoverArgs: []
    }
    installApi(apiState)
    setOwner('D:\\repo\\src\\a.cpp')
    const captured = installWithFakeMonaco()
    const { model } = makeModel('D:\\repo\\src\\a.cpp')

    const hover = (await captured.hoverProviders[0]?.provideHover(model, {
      lineNumber: 10,
      column: 6
    })) as { contents: { value: string }[]; range: Record<string, number> }

    expect(apiState.hoverArgs[0]).toEqual({
      filePath: 'D:\\repo\\src\\a.cpp',
      position: { line: 9, character: 5 }
    })
    expect(hover.contents).toEqual([{ value: '### method `GetTime`' }])
    expect(hover.range).toEqual({
      startLineNumber: 10,
      startColumn: 5,
      endLineNumber: 10,
      endColumn: 11
    })
  })

  it('returns null (no popup) when the server has no hover', async () => {
    installApi({
      definitionResult: { ok: true, locations: [] },
      hoverResult: { ok: true, hover: null },
      authorized: [],
      definitionArgs: [],
      hoverArgs: []
    })
    setOwner('D:\\repo\\src\\a.cpp')
    const captured = installWithFakeMonaco()
    const { model } = makeModel('D:\\repo\\src\\a.cpp')
    expect(
      await captured.hoverProviders[0]?.provideHover(model, { lineNumber: 1, column: 1 })
    ).toBeNull()
  })
})

describe('editor opener', () => {
  it('opens an in-worktree target with a relative path, editable, and arms the reveal', async () => {
    const apiState: ApiState = {
      definitionResult: { ok: true, locations: [] },
      hoverResult: { ok: true, hover: null },
      authorized: [],
      definitionArgs: [],
      hoverArgs: []
    }
    installApi(apiState)
    setOwner('D:\\repo\\src\\a.cpp')
    terminalLinks.isPathInsideWorktree.mockReturnValue(true)
    terminalLinks.toWorktreeRelativePath.mockReturnValue('include\\timer.hpp')
    const captured = installWithFakeMonaco()
    const { source } = makeModel('D:\\repo\\src\\a.cpp')

    const opened = await captured.openers[0]?.openCodeEditor(
      source,
      { scheme: 'file', fsPath: 'd:\\repo\\include\\timer.hpp' },
      { startLineNumber: 40, startColumn: 9, endLineNumber: 40, endColumn: 23 }
    )

    expect(opened).toBe(true)
    expect(apiState.authorized).toEqual([])
    expect(storeState.openFileCalls).toHaveLength(1)
    expect(storeState.openFileCalls[0]?.file).toMatchObject({
      filePath: 'D:\\repo\\include\\timer.hpp',
      relativePath: 'include\\timer.hpp',
      worktreeId: 'wt-1',
      mode: 'edit',
      runtimeEnvironmentId: null,
      language: 'cpp'
    })
    expect(storeState.openFileCalls[0]?.file).not.toHaveProperty('readOnly')
    expect(storeState.openFileCalls[0]?.options).toMatchObject({
      preview: false,
      forceContentReload: true,
      suppressActiveRuntimeFallback: true
    })
    expect(storeState.reveals).toEqual([
      null,
      {
        filePath: 'D:\\repo\\include\\timer.hpp',
        fileId: 'tab-1',
        line: 40,
        column: 9,
        matchLength: 14
      }
    ])
    expect(worktreeActivation.activateAndRevealWorkspace).not.toHaveBeenCalled()
  })

  it('authorizes and opens an external target read-only with the cpp language fallback', async () => {
    const apiState: ApiState = {
      definitionResult: { ok: true, locations: [] },
      hoverResult: { ok: true, hover: null },
      authorized: [],
      definitionArgs: [],
      hoverArgs: []
    }
    installApi(apiState)
    setOwner('D:\\repo\\src\\a.cpp')
    terminalLinks.isPathInsideWorktree.mockReturnValue(false)
    const captured = installWithFakeMonaco()
    const { source } = makeModel('D:\\repo\\src\\a.cpp')
    const stlHeader = 'C:\\Program Files\\Microsoft Visual Studio\\19\\include\\chrono'

    const opened = await captured.openers[0]?.openCodeEditor(
      source,
      { scheme: 'file', fsPath: stlHeader },
      { lineNumber: 108, column: 5 }
    )

    expect(opened).toBe(true)
    expect(apiState.authorized).toEqual([stlHeader])
    expect(storeState.openFileCalls[0]?.file).toMatchObject({
      filePath: stlHeader,
      // External-file contract: relativePath === absolute path.
      relativePath: stlHeader,
      readOnly: true,
      language: 'cpp'
    })
    expect(storeState.reveals[1]).toMatchObject({ line: 108, column: 5, matchLength: 1 })
  })

  it('refuses when the authorization grant fails', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        languageServers: {},
        fs: {
          authorizeExternalPath: async () => {
            throw new Error('denied')
          }
        }
      }
    })
    setOwner('D:\\repo\\src\\a.cpp')
    terminalLinks.isPathInsideWorktree.mockReturnValue(false)
    const captured = installWithFakeMonaco()
    const { source } = makeModel('D:\\repo\\src\\a.cpp')

    expect(
      await captured.openers[0]?.openCodeEditor(
        source,
        { scheme: 'file', fsPath: 'C:\\x\\y' },
        undefined
      )
    ).toBe(false)
    expect(storeState.openFileCalls).toHaveLength(0)
  })

  it('refuses non-file resources and sources without a local owner', async () => {
    const apiState: ApiState = {
      definitionResult: { ok: true, locations: [] },
      hoverResult: { ok: true, hover: null },
      authorized: [],
      definitionArgs: [],
      hoverArgs: []
    }
    installApi(apiState)
    setOwner('D:\\repo\\src\\a.cpp')
    const captured = installWithFakeMonaco()
    const { source } = makeModel('D:\\repo\\src\\a.cpp')

    expect(
      await captured.openers[0]?.openCodeEditor(source, { scheme: 'https', fsPath: 'x' }, undefined)
    ).toBe(false)
    // Owner gone from the store -> degraded navigation (spec D10).
    storeState.openFiles = []
    expect(
      await captured.openers[0]?.openCodeEditor(
        source,
        { scheme: 'file', fsPath: 'D:\\repo\\x.cpp' },
        undefined
      )
    ).toBe(false)
    expect(storeState.openFileCalls).toHaveLength(0)
  })

  it('activates the source worktree when it is not the active one', async () => {
    const apiState: ApiState = {
      definitionResult: { ok: true, locations: [] },
      hoverResult: { ok: true, hover: null },
      authorized: [],
      definitionArgs: [],
      hoverArgs: []
    }
    installApi(apiState)
    setOwner('D:\\repo\\src\\a.cpp')
    storeState.activeWorktreeId = 'wt-other'
    terminalLinks.isPathInsideWorktree.mockReturnValue(true)
    terminalLinks.toWorktreeRelativePath.mockReturnValue('x.cpp')
    const captured = installWithFakeMonaco()
    const { source } = makeModel('D:\\repo\\src\\a.cpp')

    await captured.openers[0]?.openCodeEditor(
      source,
      { scheme: 'file', fsPath: 'D:\\repo\\x.cpp' },
      undefined
    )
    expect(worktreeActivation.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true
    })
  })
})
