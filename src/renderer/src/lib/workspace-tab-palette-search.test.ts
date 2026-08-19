import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { OpenFile } from '@/store/slices/editor'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { PALETTE_QUERY_MAX_TOKENS } from './palette-match/palette-query'
import { buildSearchableWorkspaceTabs, searchWorkspaceTabs } from './workspace-tab-palette-search'

const WT_ROOT = path.join('tmp', 'wt-1')
const SRC_APP_RELATIVE_PATH = path.join('src', 'app.ts')
const SRC_APP_PATH = path.join(WT_ROOT, SRC_APP_RELATIVE_PATH)

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: WT_ROOT,
    head: 'abc123',
    branch: 'refs/heads/feature/workspace-tab-search',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Palette Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeUnifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'unified-terminal-1',
    entityId: 'terminal-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: 'Unified Label',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'terminal-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Raw Shell Title',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: SRC_APP_PATH,
    filePath: SRC_APP_PATH,
    relativePath: SRC_APP_RELATIVE_PATH,
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId: 'unified-terminal-1',
    tabOrder: ['unified-terminal-1'],
    ...overrides
  }
}

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'Implement the websocket retry loop',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'terminal-1:leaf-a',
    tabId: 'terminal-1',
    worktreeId: 'wt-1',
    stateHistory: [],
    agentType: 'codex',
    providerSession: { key: 'session_id', id: 'sess-live' },
    ...overrides
  }
}

function buildEntries(overrides: Partial<Parameters<typeof buildSearchableWorkspaceTabs>[0]> = {}) {
  const worktree = makeWorktree()
  const tab = makeUnifiedTab()
  return buildSearchableWorkspaceTabs({
    worktrees: [worktree],
    repoMap: new Map([[worktree.repoId, { displayName: 'repo/orca' }]]),
    worktreeOrder: new Map([[worktree.id, 0]]),
    unifiedTabsByWorktree: { [worktree.id]: [tab] },
    tabsByWorktree: { [worktree.id]: [makeTerminalTab()] },
    openFiles: [],
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    activeGroupIdByWorktree: { [worktree.id]: 'group-1' },
    groupsByWorktree: { [worktree.id]: [makeGroup()] },
    activeWorktreeId: worktree.id,
    activeTabType: 'terminal',
    activeTabId: 'terminal-1',
    activeTabIdByWorktree: { [worktree.id]: 'terminal-1' },
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: { [worktree.id]: 'terminal' },
    generatedTitlesEnabled: true,
    ...overrides
  })
}

describe('workspace-tab-palette-search', () => {
  it('stamps the row execution host so activation never resolves by id alone', () => {
    // Why: worktree ids repeat across hosts, so a host-blind activation opened the other
    // host's workspace behind a row labelled with this one's name and branch.
    const worktree = makeWorktree({ hostId: 'ssh:box' })
    const entries = buildEntries({ worktrees: [worktree] })
    const [result] = searchWorkspaceTabs(entries, '')
    expect(result.executionHostId).toBe('ssh:box')
  })

  it('keeps the resolvable twin when the first record under an id has no open file', () => {
    // Why: dropping the id on sight would lose the row entirely — the leading
    // record dies at the open-file lookup and the survivor never gets its turn.
    const orphaned = makeUnifiedTab({
      id: 'unified-editor-dup',
      contentType: 'editor',
      entityId: 'missing-file'
    })
    const resolvable = makeUnifiedTab({
      id: 'unified-editor-dup',
      contentType: 'editor',
      entityId: SRC_APP_PATH
    })
    const entries = buildEntries({
      unifiedTabsByWorktree: { 'wt-1': [orphaned, resolvable] },
      openFiles: [makeOpenFile()]
    })

    expect(entries.map((entry) => entry.tab.id)).toEqual(['unified-editor-dup'])
    expect(entries[0]?.secondaryText).toBe(SRC_APP_RELATIVE_PATH)
  })
  it('emits one entry per tab id when a session persisted the same id twice', () => {
    // Why: the palette keys rows by tab id, and duplicated persisted records used
    // to render the row twice under one React key, stranding a ghost row.
    const duplicate = makeUnifiedTab({ id: 'unified-terminal-dup' })
    const entries = buildEntries({
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab(), duplicate, { ...duplicate }]
      }
    })

    const tabIds = entries.map((entry) => entry.tab.id)
    expect(tabIds).toEqual(['unified-terminal-1', 'unified-terminal-dup'])

    const results = searchWorkspaceTabs(entries, 'unified')
    expect(results.map((result) => result.tabId)).toEqual(tabIds)
  })
  it('uses the same title precedence as the tab strip and honors generated-title disabling', () => {
    const enabledEntries = buildEntries({
      tabsByWorktree: {
        'wt-1': [
          makeTerminalTab({
            customTitle: 'Custom Title',
            quickCommandLabel: 'Quick Label',
            generatedTitle: 'Generated Label'
          })
        ]
      }
    })
    // customTitle on the terminal record is merged into the unified resolve path.
    expect(searchWorkspaceTabs(enabledEntries, 'custom')[0]?.title).toBe('Custom Title')

    const disabledEntries = buildEntries({
      generatedTitlesEnabled: false,
      tabsByWorktree: {
        'wt-1': [
          makeTerminalTab({
            title: 'Raw Shell Title',
            generatedTitle: 'Generated Label'
          })
        ]
      },
      // Empty unified label so the live terminal title is the visible fallback.
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ label: '' })]
      }
    })
    expect(searchWorkspaceTabs(disabledEntries, 'generated')).toHaveLength(0)
    expect(searchWorkspaceTabs(disabledEntries, 'raw')[0]?.title).toBe('Raw Shell Title')
  })

  it('falls back to the unified terminal label when the legacy terminal record is gone', () => {
    const entries = buildEntries({
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ customLabel: 'Fallback Terminal' })]
      }
    })

    expect(searchWorkspaceTabs(entries, 'fallback')[0]?.title).toBe('Fallback Terminal')
  })

  // The tab strip shows the unified label; tabsByWorktree can lag on a default
  // "Terminal N" while the label already has the live OSC agent title.
  it('indexes the unified label when the terminal record title is stale', () => {
    const entries = buildEntries({
      tabsByWorktree: {
        'wt-1': [makeTerminalTab({ title: 'Terminal 9', defaultTitle: 'Terminal 9' })]
      },
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ label: '✳ Claude Code' })]
      }
    })

    expect(searchWorkspaceTabs(entries, 'claude')[0]?.title).toBe('✳ Claude Code')
    expect(searchWorkspaceTabs(entries, 'terminal 9')).toHaveLength(0)
  })

  it('indexes editor-family tabs through existing editor labels and paths', () => {
    const previewRelativePath = path.join('docs', 'readme.md')
    const previewPath = path.join(WT_ROOT, previewRelativePath)
    const file = makeOpenFile({
      id: `${previewPath}:preview`,
      filePath: previewPath,
      relativePath: previewRelativePath,
      mode: 'markdown-preview'
    })
    const entries = buildEntries({
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({
            id: 'editor-preview',
            entityId: file.id,
            contentType: 'editor',
            label: 'ignored'
          }),
          makeUnifiedTab({
            id: 'missing-diff',
            entityId: path.join(WT_ROOT, 'missing.ts'),
            contentType: 'diff'
          })
        ]
      },
      openFiles: [file],
      activeTabType: 'editor',
      activeTabId: null,
      activeTabIdByWorktree: {},
      activeFileId: file.id,
      activeFileIdByWorktree: { 'wt-1': file.id },
      activeTabTypeByWorktree: { 'wt-1': 'editor' },
      groupsByWorktree: {
        'wt-1': [makeGroup({ activeTabId: 'editor-preview', tabOrder: ['editor-preview'] })]
      }
    })

    expect(entries.map((entry) => entry.tab.id)).toEqual(['editor-preview'])
    expect(searchWorkspaceTabs(entries, 'preview')[0]?.title).toBe('readme.md (preview)')
    expect(searchWorkspaceTabs(entries, path.join('docs', 'readme'))[0]?.secondaryRanges).toEqual([
      { start: 0, end: 11 }
    ])
  })

  it('indexes all editor-family content types when their backing file is open', () => {
    const editorFile = makeOpenFile({
      id: SRC_APP_PATH,
      filePath: SRC_APP_PATH,
      relativePath: SRC_APP_RELATIVE_PATH,
      mode: 'edit'
    })
    const diffFile = makeOpenFile({
      id: 'wt-1::diff::staged::src/app.ts',
      filePath: SRC_APP_PATH,
      relativePath: SRC_APP_RELATIVE_PATH,
      mode: 'diff',
      diffSource: 'staged'
    })
    const conflictReviewFile = makeOpenFile({
      id: 'wt-1::conflict-review',
      filePath: WT_ROOT,
      relativePath: 'Conflict Review',
      mode: 'conflict-review'
    })
    const checkDetailsFile = makeOpenFile({
      id: 'wt-1::check-details::check-run:42',
      filePath: WT_ROOT,
      relativePath: 'CI / Typecheck',
      mode: 'check-details'
    })
    const files = [editorFile, diffFile, conflictReviewFile, checkDetailsFile]
    const entries = buildEntries({
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({
            id: 'editor-tab',
            entityId: editorFile.id,
            contentType: 'editor'
          }),
          makeUnifiedTab({
            id: 'diff-tab',
            entityId: diffFile.id,
            contentType: 'diff'
          }),
          makeUnifiedTab({
            id: 'conflict-tab',
            entityId: conflictReviewFile.id,
            contentType: 'conflict-review'
          }),
          makeUnifiedTab({
            id: 'check-tab',
            entityId: checkDetailsFile.id,
            contentType: 'check-details'
          })
        ]
      },
      openFiles: files,
      groupsByWorktree: {
        'wt-1': [
          makeGroup({
            activeTabId: 'editor-tab',
            tabOrder: ['editor-tab', 'diff-tab', 'conflict-tab', 'check-tab']
          })
        ]
      }
    })

    expect(entries.map((entry) => entry.tab.contentType)).toEqual([
      'editor',
      'diff',
      'conflict-review',
      'check-details'
    ])
    expect(searchWorkspaceTabs(entries, 'staged diff')[0]?.tabId).toBe('diff-tab')
    expect(searchWorkspaceTabs(entries, 'conflict review')[0]?.tabId).toBe('conflict-tab')
    expect(searchWorkspaceTabs(entries, 'typecheck')[0]?.tabId).toBe('check-tab')
  })

  it('attaches live, retained, and sleeping agent metadata only to matching terminal tabs', () => {
    const retainedEntry = makeAgentEntry({
      paneKey: 'terminal-1:leaf-b',
      prompt: 'Retained branch cleanup',
      tabId: undefined,
      providerSession: { key: 'session_id', id: 'sess-retained' }
    })
    const retained: RetainedAgentEntry = {
      entry: retainedEntry,
      worktreeId: 'wt-1',
      tab: makeTerminalTab({ id: 'terminal-1', title: 'Retained Title' }),
      agentType: 'codex',
      startedAt: 1
    }
    const sleeping: SleepingAgentSessionRecord = {
      paneKey: 'terminal-1:leaf-c',
      tabId: 'terminal-1',
      worktreeId: 'wt-1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'sess-sleeping' },
      prompt: 'Sleeping deployment notes',
      state: 'waiting',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const entries = buildEntries({
      agentStatusByPaneKey: {
        'terminal-1:leaf-a': makeAgentEntry(),
        'terminal-2:leaf-x': makeAgentEntry({
          paneKey: 'terminal-2:leaf-x',
          tabId: 'terminal-2',
          prompt: 'Wrong tab prompt'
        }),
        'terminal-1:leaf-y': makeAgentEntry({
          paneKey: 'terminal-1:leaf-y',
          worktreeId: 'wt-other',
          prompt: 'Wrong worktree prompt'
        })
      },
      retainedAgentsByPaneKey: { [retained.entry.paneKey]: retained },
      sleepingAgentSessionsByPaneKey: { [sleeping.paneKey]: sleeping }
    })

    expect(searchWorkspaceTabs(entries, 'websocket')[0]?.secondaryText).toBe(
      'Implement the websocket retry loop'
    )
    expect(searchWorkspaceTabs(entries, 'retained')[0]?.secondaryText).toBe(
      'Retained branch cleanup'
    )
    expect(searchWorkspaceTabs(entries, 'sess-sleeping')).toHaveLength(1)
    expect(searchWorkspaceTabs(entries, 'wrong tab')).toHaveLength(0)
    expect(searchWorkspaceTabs(entries, 'wrong worktree')).toHaveLength(0)
  })

  it('deduplicates live, retained, and sleeping metadata by pane key with live preferred', () => {
    const retainedEntry = makeAgentEntry({
      paneKey: 'terminal-1:leaf-a',
      prompt: 'Retained duplicate prompt'
    })
    const entries = buildEntries({
      agentStatusByPaneKey: {
        'terminal-1:leaf-a': makeAgentEntry({ prompt: 'Live duplicate prompt' })
      },
      retainedAgentsByPaneKey: {
        'terminal-1:leaf-a': {
          entry: retainedEntry,
          worktreeId: 'wt-1',
          tab: makeTerminalTab(),
          agentType: 'codex',
          startedAt: 1
        }
      },
      sleepingAgentSessionsByPaneKey: {
        'terminal-1:leaf-a': {
          paneKey: 'terminal-1:leaf-a',
          tabId: 'terminal-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-sleeping' },
          prompt: 'Sleeping duplicate prompt',
          state: 'waiting',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    expect(searchWorkspaceTabs(entries, 'live duplicate')[0]?.secondaryText).toBe(
      'Live duplicate prompt'
    )
    expect(searchWorkspaceTabs(entries, 'retained duplicate')).toHaveLength(0)
    expect(searchWorkspaceTabs(entries, 'sleeping duplicate')).toHaveLength(0)
  })

  it('orders empty-query results by current tab, current worktree, and tab position', () => {
    const current = makeUnifiedTab({ id: 'tab-current', entityId: 'terminal-current' })
    const sibling = makeUnifiedTab({
      id: 'tab-sibling',
      entityId: 'terminal-sibling',
      sortOrder: 1
    })
    const other = makeUnifiedTab({
      id: 'tab-other',
      entityId: 'terminal-other',
      worktreeId: 'wt-2',
      groupId: 'group-2'
    })
    const entries = buildEntries({
      worktrees: [
        makeWorktree({ id: 'wt-1', displayName: 'Current WT' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-2', displayName: 'Other WT' })
      ],
      repoMap: new Map([
        ['repo-1', { displayName: 'repo/current' }],
        ['repo-2', { displayName: 'repo/other' }]
      ]),
      worktreeOrder: new Map([
        ['wt-1', 1],
        ['wt-2', 2]
      ]),
      unifiedTabsByWorktree: { 'wt-1': [sibling, current], 'wt-2': [other] },
      tabsByWorktree: {
        'wt-1': [
          makeTerminalTab({ id: 'terminal-sibling', title: 'Sibling' }),
          makeTerminalTab({ id: 'terminal-current', title: 'Current' })
        ],
        'wt-2': [makeTerminalTab({ id: 'terminal-other', worktreeId: 'wt-2', title: 'Other' })]
      },
      groupsByWorktree: {
        'wt-1': [
          makeGroup({
            activeTabId: 'tab-current',
            tabOrder: ['tab-current', 'tab-sibling']
          })
        ],
        'wt-2': [makeGroup({ id: 'group-2', worktreeId: 'wt-2', tabOrder: ['tab-other'] })]
      },
      activeTabId: 'terminal-current',
      activeTabIdByWorktree: { 'wt-1': 'terminal-current' }
    })

    expect(searchWorkspaceTabs(entries, '').map((result) => result.entityId)).toEqual([
      'terminal-current',
      'terminal-sibling',
      'terminal-other'
    ])
  })

  it('falls back to the branch label when a cleared display name left it undefined', () => {
    // Why: Cmd+J runs this search over the same worktree objects as searchWorktrees,
    // so the store-level display-name corruption reaches here too.
    const cleared = makeWorktree({
      displayName: undefined as unknown as string,
      branch: 'refs/heads/feature/workspace-tab-search'
    })
    const entries = buildEntries({ worktrees: [cleared] })

    expect(searchWorkspaceTabs(entries, 'workspace-tab-search')[0]).toMatchObject({
      worktreeName: 'feature/workspace-tab-search',
      worktreeRanges: [{ start: 'feature/'.length, end: 'feature/workspace-tab-search'.length }]
    })
  })

  it('lists a branch-less row on the empty query without throwing', () => {
    const cleared = makeWorktree({
      displayName: undefined as unknown as string,
      branch: undefined as unknown as string,
      path: path.join('repos', 'design-review')
    })
    const entries = buildEntries({ worktrees: [cleared] })

    expect(searchWorkspaceTabs(entries, '')[0]).toMatchObject({
      worktreeName: 'design-review',
      worktreeRanges: []
    })
  })

  it('omits the fixed Terminal tab secondary on terminals', () => {
    const entries = buildEntries()
    const emptyQuery = searchWorkspaceTabs(entries, '')[0]
    expect(emptyQuery).toMatchObject({
      contentType: 'terminal',
      secondaryText: '',
      secondaryRanges: []
    })
    expect(entries[0]?.secondarySearchTexts).toEqual([])
  })

  it('still finds terminals via type aliases without showing a secondary', () => {
    // Title is agent-named so the hit has to come from the type alias, not the title.
    const entries = buildEntries({
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ label: 'Fix login race' })] }
    })
    const hit = searchWorkspaceTabs(entries, 'terminal')[0]
    expect(hit).toMatchObject({
      contentType: 'terminal',
      title: 'Fix login race',
      secondaryText: '',
      secondaryRanges: [],
      // The bare alias matches exactly, so it outranks "terminal tab"; its range
      // indexes the alias string, not the row.
      typeAliasMatch: { text: 'terminal', ranges: [{ start: 0, end: 8 }] }
    })
  })

  it('matches a query spanning the tab title and the worktree branch', () => {
    const entries = buildEntries({
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ label: 'Fix login race' })] }
    })

    const hit = searchWorkspaceTabs(entries, 'login workspace-tab-search')[0]
    expect(hit?.titleRanges).toEqual([{ start: 4, end: 9 }])
    expect(hit?.branchRanges).toEqual([
      { start: 'feature/'.length, end: 'feature/workspace-tab-search'.length }
    ])
  })

  it('keeps an agent-snippet-only hit but sorts it after every structured hit', () => {
    const entries = buildEntries({
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({ id: 'tab-agent', entityId: 'terminal-agent', label: 'Claude Code' }),
          makeUnifiedTab({ id: 'tab-title', entityId: 'terminal-title', label: 'Websocket notes' })
        ]
      },
      agentStatusByPaneKey: {
        'terminal-agent:leaf-a': makeAgentEntry({ tabId: 'terminal-agent' })
      },
      groupsByWorktree: {
        'wt-1': [makeGroup({ activeTabId: 'tab-agent', tabOrder: ['tab-agent', 'tab-title'] })]
      }
    })

    const results = searchWorkspaceTabs(entries, 'websocket')
    expect(results.map((result) => result.tabId)).toEqual(['tab-title', 'tab-agent'])
    expect(results[1].secondaryText).toBe('Implement the websocket retry loop')
  })

  it('rejects a query with more unique tokens than the matcher accepts', () => {
    const query = Array.from({ length: PALETTE_QUERY_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(' ')
    expect(searchWorkspaceTabs(buildEntries(), query)).toEqual([])
  })

  it('stamps grok occupancy from the idle OSC title the sidebar already shows', () => {
    const titledOnly = buildEntries({
      tabsByWorktree: { 'wt-1': [makeTerminalTab({ title: 'grok' })] },
      unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ label: 'grok' })] }
    })
    expect(titledOnly[0]?.occupantAgent).toBe('grok')
    expect(searchWorkspaceTabs(titledOnly, 'grok')[0]?.occupantAgent).toBe('grok')
  })

  it('stamps occupancy from the live unified label when the terminal record title is stale', () => {
    const staleRecord = buildEntries({
      tabsByWorktree: { 'wt-1': [makeTerminalTab({ title: 'Terminal 1' })] },
      unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ label: 'grok' })] }
    })
    expect(staleRecord[0]?.title).toBe('grok')
    expect(staleRecord[0]?.occupantAgent).toBe('grok')
  })

  it('does not stamp grok occupancy from a hyphenated filename-style title', () => {
    const hyphenated = buildEntries({
      tabsByWorktree: { 'wt-1': [makeTerminalTab({ title: 'session-scanner-grok-parser' })] },
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ label: 'session-scanner-grok-parser' })]
      }
    })
    expect(hyphenated[0]?.occupantAgent).toBeNull()
  })
})
