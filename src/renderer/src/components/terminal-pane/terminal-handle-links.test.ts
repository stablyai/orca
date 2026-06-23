import type { ILink } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalHandleLinkProvider,
  extractTerminalHandleLinks,
  findTerminalHandleTarget,
  focusRendererTerminalHandle
} from './terminal-handle-links'

const mocks = vi.hoisted(() => ({
  activateTabAndFocusPane: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  storeState: {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    setActiveView: vi.fn(),
    setActiveTabType: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    setActiveTab: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

type TestBufferLine = {
  isWrapped: boolean
  length: number
  translateToString: (
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
    outColumns?: number[]
  ) => string
}

function makeBufferLine(text: string, options: { isWrapped?: boolean } = {}): TestBufferLine {
  return {
    isWrapped: options.isWrapped ?? false,
    length: text.length,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.length = 0
        for (let index = startColumn; index <= endColumn; index++) {
          outColumns.push(index)
        }
      }
      return text.slice(startColumn, endColumn)
    }
  }
}

function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

async function collectLinks(rows: TestBufferLine[], bufferLineNumber = 1): Promise<ILink[]> {
  const terminal = {
    buffer: {
      active: {
        getLine: (y: number) => rows[y]
      }
    },
    clearSelection: vi.fn()
  }
  const provider = createTerminalHandleLinkProvider({
    getTerminal: () => terminal as never,
    getRuntimeEnvironmentId: () => null,
    linkTooltip: { textContent: '', style: { display: '' } } as unknown as HTMLElement
  })
  return await new Promise<ILink[]>((resolve) => {
    provider.provideLinks(bufferLineNumber, (links) => resolve(links ?? []))
  })
}

describe('extractTerminalHandleLinks', () => {
  it('detects UUID terminal handles from orchestration output', () => {
    const line = '- Terminal: term_d422ff9f-42c8-4d70-bb6a-71762b21ab95'

    expect(extractTerminalHandleLinks(line)).toEqual([
      {
        handle: 'term_d422ff9f-42c8-4d70-bb6a-71762b21ab95',
        startIndex: 12,
        endIndex: 53
      }
    ])
  })

  it('trims sentence punctuation without matching inside longer tokens', () => {
    expect(extractTerminalHandleLinks('Open term_worker, not xterm_worker.')).toEqual([
      { handle: 'term_worker', startIndex: 5, endIndex: 16 }
    ])
  })

  it('scans huge handle-like terminal lines without regex iteration', () => {
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const line = `${'term_'.repeat(20_000)} Open term_worker`

    expect(extractTerminalHandleLinks(line)).toEqual([
      {
        handle: 'term_worker',
        startIndex: line.length - 'term_worker'.length,
        endIndex: line.length
      }
    ])
    expect(matchAll).not.toHaveBeenCalled()
  })

  it('ignores overlong handle tokens', () => {
    expect(extractTerminalHandleLinks(`Open term_${'a'.repeat(129)}`)).toEqual([])
  })
})

describe('findTerminalHandleTarget', () => {
  it('finds split-pane remote runtime handles from leaf PTY mappings', () => {
    expect(
      findTerminalHandleTarget('term_remote', {
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              worktreeId: 'wt-1',
              ptyId: null,
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { 'tab-1': ['remote:env-1@@term_remote'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: 'leaf-a' },
            activeLeafId: 'leaf-a',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-a': 'remote:env-1@@term_remote' }
          }
        }
      })
    ).toEqual({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-a' })
  })
})

describe('focusRendererTerminalHandle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.tabsByWorktree = {
      'wt-1': [
        {
          id: 'tab-1',
          worktreeId: 'wt-1',
          ptyId: 'term_direct',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    mocks.storeState.ptyIdsByTabId = { 'tab-1': ['term_direct'] }
    mocks.storeState.terminalLayoutsByTabId = {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activates a local renderer target without runtime lookup', () => {
    expect(focusRendererTerminalHandle('term_direct')).toBe(true)

    expect(mocks.storeState.setActiveWorktree).toHaveBeenCalledWith('wt-1')
    expect(mocks.storeState.setActiveView).toHaveBeenCalledWith('terminal')
    expect(mocks.storeState.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mocks.storeState.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
  })
})

describe('createTerminalHandleLinkProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('Macintosh')
    mocks.storeState.tabsByWorktree = {}
    mocks.storeState.ptyIdsByTabId = {}
    mocks.storeState.terminalLayoutsByTabId = {}
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn().mockResolvedValue({
            ok: true,
            result: { focus: { handle: 'term_worker', tabId: 'tab-1', worktreeId: 'wt-1' } }
          })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('provides wrapped terminal handle links and focuses through runtime on activation', async () => {
    const rows = [makeBufferLine('Worker: term_work'), makeBufferLine('er', { isWrapped: true })]
    const links = await collectLinks(rows, 1)

    expect(links.map((link) => link.text)).toEqual(['term_worker'])
    links[0].activate(
      {
        metaKey: true,
        ctrlKey: false,
        preventDefault: vi.fn()
      } as unknown as MouseEvent,
      links[0].text
    )
    await Promise.resolve()

    expect(window.api.runtime.call).toHaveBeenCalledWith({
      method: 'terminal.focus',
      params: { terminal: 'term_worker' }
    })
  })

  it('contains runtime focus failures for stale terminal handles', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.api.runtime.call = vi.fn().mockRejectedValue(new Error('terminal not found'))

    try {
      const links = await collectLinks([makeBufferLine('Worker: term_gone')])
      links[0].activate(
        {
          metaKey: true,
          ctrlKey: false,
          preventDefault: vi.fn()
        } as unknown as MouseEvent,
        links[0].text
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(consoleWarn).toHaveBeenCalledWith(
        '[terminal-handle-link] focus failed:',
        expect.any(Error)
      )
    } finally {
      consoleWarn.mockRestore()
    }
  })
})
