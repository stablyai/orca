import type { ILink } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  createTerminalHandleLinkProvider,
  extractTerminalHandleLinks,
  findTerminalHandleTarget
} from './terminal-handle-links'
import { extractOrchestrationTaskLinks } from './terminal-orchestration-task-links'
import type { TerminalLinkActionContext } from '../terminal-link-action-request'

const mocks = vi.hoisted(() => ({
  activateTabAndFocusPane: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  revealFloatingWorkspacePanel: vi.fn(),
  storeState: {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    isNavigatingHistory: false,
    setActiveView: vi.fn(),
    setActiveTabType: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    setActiveTab: vi.fn()
  }
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/lib/workspace/tabs/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

vi.mock('@/lib/floating-workspace-panel-reveal', () => ({
  revealFloatingWorkspacePanel: mocks.revealFloatingWorkspacePanel
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

async function collectLinks(
  rows: TestBufferLine[],
  bufferLineNumber = 1,
  runtimeEnvironmentId: string | null = null,
  linkActionContext?: TerminalLinkActionContext
): Promise<ILink[]> {
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
    getRuntimeEnvironmentId: () => runtimeEnvironmentId,
    linkTooltip: { textContent: '', style: { display: '' } } as unknown as HTMLElement,
    getLinkActionContext: () => linkActionContext ?? null
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

  it('ignores overlong handle tokens', () => {
    expect(extractTerminalHandleLinks(`Open term_${'a'.repeat(129)}`)).toEqual([])
  })
})

describe('extractOrchestrationTaskLinks', () => {
  it('detects task IDs from orchestration dispatch output', () => {
    const line = 'Ran orca orchestration dispatch --task task_88f323f654c0 --to term_worker'

    expect(extractOrchestrationTaskLinks(line)).toEqual([
      {
        taskId: 'task_88f323f654c0',
        startIndex: 39,
        endIndex: 56
      }
    ])
  })

  it('trims sentence punctuation without matching inside longer tokens', () => {
    expect(extractOrchestrationTaskLinks('Open task_worker, not xtask_worker.')).toEqual([
      { taskId: 'task_worker', startIndex: 5, endIndex: 16 }
    ])
  })

  it('caps orchestration task IDs by full token length', () => {
    const maxLengthTaskId = `task_${'a'.repeat(123)}`

    expect(extractOrchestrationTaskLinks(`Open ${maxLengthTaskId}`)).toEqual([
      { taskId: maxLengthTaskId, startIndex: 5, endIndex: 133 }
    ])
    expect(extractOrchestrationTaskLinks(`Open task_${'a'.repeat(124)}`)).toEqual([])
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

describe('createTerminalHandleLinkProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('Macintosh')
    mocks.storeState.tabsByWorktree = {}
    mocks.storeState.ptyIdsByTabId = {}
    mocks.storeState.terminalLayoutsByTabId = {}
    mocks.storeState.agentStatusByPaneKey = {}
    mocks.storeState.retainedAgentsByPaneKey = {}
    mocks.storeState.runtimeAgentOrchestrationByPaneKey = {}
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn().mockImplementation(({ method }) => {
            if (method === 'orchestration.dispatchShow') {
              return Promise.resolve({
                ok: true,
                result: { dispatch: { assignee_handle: 'term_worker' } }
              })
            }
            return Promise.resolve({
              ok: true,
              result: { focus: { handle: 'term_worker', tabId: 'tab-1', worktreeId: 'wt-1' } }
            })
          })
        },
        runtimeEnvironments: {
          call: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
  })

  it('returns task and terminal links in line order', async () => {
    const links = await collectLinks([
      makeBufferLine('Dispatch --task task_worker --to term_worker')
    ])

    expect(links.map((link) => link.text)).toEqual(['task_worker', 'term_worker'])
  })
})
