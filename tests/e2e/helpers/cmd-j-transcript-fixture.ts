import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { AiVaultSearchHit } from '../../../src/shared/ai-vault-search-types'
import { makePaneKey } from '../../../src/shared/stable-pane-id'
import {
  LEAF_ID,
  makeAgentEntry,
  makeGroup,
  makeTerminalTab,
  makeUnifiedTab
} from '../../../src/renderer/src/components/worktree-jump-palette-test-fixtures'

export async function seedTranscriptPalette(
  page: Page,
  count = 50,
  query = 'refresh',
  additional = 20
): Promise<void> {
  const worktree = await page.evaluate(() => {
    const state = window.__store!.getState()
    const worktree = state.allWorktrees().find((item) => item.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('Missing seeded worktree')
    }
    return worktree
  })
  const ordinaryTitle =
    query === 'refresh'
      ? 'refresg discussion'
      : query
          .split(' ')
          .map((word) => `pre${word}post`)
          .join(' ')
  const tabs = Array.from({ length: count + additional }, (_, index) => {
    const id = `transcript-fixture-${index}`
    return makeUnifiedTab(
      id,
      worktree.id,
      id,
      index < count ? `${ordinaryTitle} ${index}` : `Useful conversation ${index - count}`
    )
  })
  const terminals = tabs.map((tab) => makeTerminalTab(tab.id, worktree.id, tab.label))
  const agentStatus = Object.fromEntries(
    tabs.map((tab) => [
      makePaneKey(tab.id, LEAF_ID),
      makeAgentEntry(tab.id, 'done', 0, {
        agentType: 'claude',
        tabId: tab.id,
        worktreeId: worktree.id,
        providerSession: { key: 'session_id', id: `session-${tab.id}` }
      })
    ])
  )
  const layouts = Object.fromEntries(
    tabs.map((tab) => [
      tab.id,
      {
        root: { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    ])
  )
  await page.evaluate(
    ({ worktree, tabs, terminals, agentStatus, layouts, group }) => {
      const store = window.__store!
      const state = store.getState()
      if (!state.settings) {
        throw new Error('Missing hydrated settings')
      }
      store.setState({
        settings: { ...state.settings, aiVaultSearch: { enabled: true, historyDays: null } },
        filterRepoIds: [],
        visibleWorkspaceHostIds: [],
        hideDefaultBranchWorkspace: false,
        worktreesByRepo: {
          [worktree.repoId]: [
            { ...worktree, hostId: 'local', displayName: 'prerefreshpost workspace' }
          ]
        },
        unifiedTabsByWorktree: { [worktree.id]: tabs },
        tabsByWorktree: { [worktree.id]: terminals },
        groupsByWorktree: { [worktree.id]: [group] },
        activeGroupIdByWorktree: { [worktree.id]: group.id },
        agentStatusByPaneKey: agentStatus,
        terminalLayoutsByTabId: layouts,
        sleepingAgentSessionsByPaneKey: {},
        retainedAgentsByPaneKey: {},
        activeTabId: null,
        activeTabIdByWorktree: {},
        activeModal: 'worktree-palette'
      })
    },
    {
      worktree,
      tabs,
      terminals,
      agentStatus,
      layouts,
      group: makeGroup(
        worktree.id,
        tabs.map((tab) => tab.id)
      )
    }
  )
}

export function transcriptHits(
  count = 50,
  originalText = 'We fixed the token refresh race in this conversation.',
  hitCount = 20
): AiVaultSearchHit[] {
  return Array.from({ length: hitCount }, (_, index) => ({
    agent: 'claude',
    sessionId: `session-transcript-fixture-${count + index}`,
    title: 'Indexed conversation',
    cwd: null,
    branch: null,
    updatedAt: null,
    messageCount: 2,
    score: 1,
    source: { presence: 'present' },
    evidence: {
      role: 'assistant',
      timestamp: null,
      snippet: 'a [[refresh]] …',
      originalExcerpt: { text: originalText }
    }
  }))
}

export async function deferTranscriptResponse(
  app: ElectronApplication,
  hits = transcriptHits()
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, response) => {
      let released = false
      ipcMain.on('test:release-cmd-j-transcripts', () => {
        released = true
      })
      ipcMain.removeHandler('aiVault:searchSessions')
      ipcMain.handle('aiVault:searchSessions', () =>
        released
          ? response
          : new Promise((resolve) => {
              ipcMain.once('test:release-cmd-j-transcripts', () => resolve(response))
            })
      )
    },
    {
      kind: 'results',
      eligibleSessionsApplied: true,
      forksPreserved: true,
      hits,
      page: { cursor: null, hasMore: false },
      generation: 7,
      truncated: { candidates: false, snippets: 0, query: false, freshness: false },
      durationMs: 1
    }
  )
}

export async function releaseTranscriptResponse(
  app: ElectronApplication,
  delayMs = 0
): Promise<void> {
  await app.evaluate(({ ipcMain }, delayMs) => {
    if (delayMs > 0) {
      setTimeout(() => ipcMain.emit('test:release-cmd-j-transcripts'), delayMs)
    } else {
      ipcMain.emit('test:release-cmd-j-transcripts')
    }
  }, delayMs)
}
