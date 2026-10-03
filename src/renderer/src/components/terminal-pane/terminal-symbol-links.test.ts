import type { ILink, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  lookupWorkspaceSymbol: vi.fn(),
  openDetectedFilePath: vi.fn(),
  toast: vi.fn(),
  isMac: true
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/lib/lsp/lsp-workspace-symbol-lookup', () => ({
  lookupWorkspaceSymbol: mocks.lookupWorkspaceSymbol
}))
vi.mock('./terminal-file-open-routing', () => ({
  openDetectedFilePath: mocks.openDetectedFilePath
}))
vi.mock('./terminal-link-open-hints', () => ({ isMacPlatform: () => mocks.isMac }))
vi.mock('./wrapped-terminal-link-ranges', () => ({
  buildWrappedLogicalLine: (_buffer: unknown, _line: number) => ({ text: 'raise Greeter here' }),
  rangeForParsedFileLink: (_line: unknown, start: number, end: number) => ({
    start: { x: start + 1, y: 1 },
    end: { x: end, y: 1 }
  })
}))

import type { Repo } from '../../../../shared/repo-types'
import {
  createTerminalSymbolLinkProvider,
  extractSymbolTokens,
  isSymbolLookupEnabledForRepo
} from './terminal-symbol-links'

describe('extractSymbolTokens', () => {
  it('finds qualified identifiers with exclusive end indexes', () => {
    const line = 'NoMethodError: undefined method `total` for Billing::Invoice#charge!'
    const tokens = extractSymbolTokens(line)
    expect(tokens.map((t) => t.text)).toEqual([
      'NoMethodError',
      'undefined',
      'method',
      'total',
      'Billing::Invoice#charge!'
    ])
    const invoice = tokens.at(-1)
    expect(line.slice(invoice?.startIndex, invoice?.endIndex)).toBe('Billing::Invoice#charge!')
  })

  it('skips short tokens and numbers', () => {
    expect(extractSymbolTokens('at 12 go for the x1').map((t) => t.text)).toEqual([])
  })
})

const terminalElement = { isConnected: true }

function fakeTerminal(): Terminal {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider only reads buffer.active and element, and calls clearSelection.
  return {
    buffer: { active: {} },
    element: terminalElement,
    clearSelection: vi.fn()
  } as unknown as Terminal
}

function createProvider(
  isLspEnabled: boolean
): ReturnType<typeof createTerminalSymbolLinkProvider> {
  return createTerminalSymbolLinkProvider({
    getTerminal: fakeTerminal,
    worktreeId: 'repo::/work/app',
    worktreePath: '/work/app',
    isLspEnabled: () => isLspEnabled
  })
}

function linksFrom(provider: ReturnType<typeof createProvider>): ILink[] | undefined {
  let links: ILink[] | undefined
  provider.provideLinks(1, (result) => {
    links = result
  })
  return links
}

function provideLinks(isLspEnabled: boolean): ILink[] | undefined {
  return linksFrom(createProvider(isLspEnabled))
}

function greeterLink(): ILink {
  const link = provideLinks(true)?.find((candidate) => candidate.text === 'Greeter')
  if (!link) {
    throw new Error('expected a Greeter link')
  }
  return link
}

function click(metaKey: boolean): MouseEvent {
  // Why: the test env has no DOM; activate only reads modifiers and calls preventDefault.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activate only reads button, modifiers and preventDefault.
  return { metaKey, ctrlKey: false, button: 0, preventDefault: vi.fn() } as unknown as MouseEvent
}

describe('createTerminalSymbolLinkProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isMac = true
  })

  it('provides no links when no language server is enabled', () => {
    expect(provideLinks(false)).toBeUndefined()
    expect(mocks.lookupWorkspaceSymbol).not.toHaveBeenCalled()
  })

  it('ignores activation without the platform modifier', () => {
    greeterLink().activate(click(false), 'Greeter')
    expect(mocks.lookupWorkspaceSymbol).not.toHaveBeenCalled()
  })

  it('opens the top-ranked definition with 1-based line and column on modifier click', async () => {
    mocks.lookupWorkspaceSymbol.mockResolvedValue([
      {
        name: 'Greeter',
        kind: 5,
        containerName: null,
        uri: 'file:///work/app/lib/greeter.rb',
        line: 0,
        character: 6
      }
    ])
    greeterLink().activate(click(true), 'Greeter')
    await vi.waitFor(() => expect(mocks.openDetectedFilePath).toHaveBeenCalled())
    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/work/app/lib/greeter.rb',
      1,
      7,
      expect.objectContaining({ worktreeId: 'repo::/work/app', worktreePath: '/work/app' })
    )
  })

  it('shows a toast when no definition matches', async () => {
    mocks.lookupWorkspaceSymbol.mockResolvedValue([])
    greeterLink().activate(click(true), 'Greeter')
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
  })

  it('shows the toast instead of rejecting on a non-file or invalid URI', async () => {
    mocks.lookupWorkspaceSymbol.mockResolvedValue([
      { name: 'Greeter', kind: 5, containerName: null, uri: 'not a uri', line: 0, character: 0 }
    ])
    greeterLink().activate(click(true), 'Greeter')
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
  })
})

describe('modifier key watcher', () => {
  const add = vi.fn()
  const remove = vi.fn()

  function hover(provider: ReturnType<typeof createProvider>): ILink {
    const link = linksFrom(provider)?.find((candidate) => candidate.text === 'Greeter')
    if (!link) {
      throw new Error('expected a Greeter link')
    }
    link.hover?.(click(true), 'Greeter')
    return link
  }

  beforeEach(() => {
    vi.clearAllMocks()
    terminalElement.isConnected = true
    vi.stubGlobal('document', { addEventListener: add, removeEventListener: remove })
    vi.stubGlobal('queueMicrotask', () => {})
  })
  afterEach(() => vi.unstubAllGlobals())

  it('adds one keydown and one keyup listener per hover without stacking', () => {
    const provider = createProvider(true)
    hover(provider)
    expect(add.mock.calls.map((call) => call[0])).toEqual(['keydown', 'keyup'])
    hover(provider)
    expect(add).toHaveBeenCalledTimes(4)
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('removes the listeners on leave', () => {
    hover(createProvider(true)).leave?.(click(false), 'Greeter')
    expect(remove.mock.calls.map((call) => call[0])).toEqual(['keydown', 'keyup'])
  })

  it('removes the listeners on dispose without leave', () => {
    const provider = createProvider(true)
    hover(provider)
    provider.dispose()
    expect(remove.mock.calls.map((call) => call[0])).toEqual(['keydown', 'keyup'])
  })

  it('removes the listeners when the terminal element is disconnected', () => {
    hover(createProvider(true))
    terminalElement.isConnected = false
    add.mock.calls[0][1](click(true))
    expect(remove.mock.calls.map((call) => call[0])).toEqual(['keydown', 'keyup'])
  })
})

describe('isSymbolLookupEnabledForRepo', () => {
  function repo(extra: Partial<Repo>): Repo {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only host and languageServers fields are read.
    return { languageServers: { enabled: { ruby: true } }, ...extra } as unknown as Repo
  }

  it('is true for a local repo with an enabled server', () => {
    expect(isSymbolLookupEnabledForRepo(repo({}))).toBe(true)
  })

  it('is false without an enabled server or repo', () => {
    expect(isSymbolLookupEnabledForRepo(repo({ languageServers: { enabled: {} } }))).toBe(false)
    expect(isSymbolLookupEnabledForRepo(undefined)).toBe(false)
  })

  it('is false for a remote repo even with enabled flags', () => {
    expect(isSymbolLookupEnabledForRepo(repo({ connectionId: 'ssh-1' }))).toBe(false)
  })
})
