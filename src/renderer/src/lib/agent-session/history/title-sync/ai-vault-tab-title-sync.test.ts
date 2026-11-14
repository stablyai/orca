import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSessionTitlesArgs } from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import { removeLayoutLeaf } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { resolveTerminalTabTitle } from '../../../../../../shared/tab-title-resolution'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'

describe('AI Vault tab title sync', () => {
  it.each(['close', 'authority retirement', 'placement prune', 'providerless successor'])(
    'names the remaining conversation after %s of a non-active departed pane',
    async (change) => {
      const store = createTestStore()
      const a = '00000000-0000-4000-8000-000000000001'
      const b = '00000000-0000-4000-8000-000000000002'
      const c = '00000000-0000-4000-8000-000000000003'
      const paneA = `tab-1:${a}`
      const layout: AppState['terminalLayoutsByTabId'][string] = {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: a },
          second: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: b },
            second: { type: 'leaf', leafId: c }
          }
        },
        activeLeafId: c,
        expandedLeafId: null,
        ptyIdsByLeafId: { [c]: 'pty-shell' }
      }
      store.setState({
        activeWorktreeId: 'wt-title',
        activeWorkspaceExecutionHostId: 'local',
        tabsByWorktree: {
          'wt-title': [makeTab({ id: 'tab-1', worktreeId: 'wt-title', ptyId: 'pty-shell' })]
        },
        terminalLayoutsByTabId: { 'tab-1': layout }
      })
      for (const [leaf, id] of [
        [a, 'conversation-a'],
        [b, 'conversation-b']
      ]) {
        const key = `tab-1:${leaf}`
        store
          .getState()
          .setAgentStatus(
            key,
            { state: 'done', prompt: 'finished task', agentType: 'codex' },
            undefined,
            { updatedAt: 1000, stateStartedAt: 1000, turnStartedAt: 1000 },
            { tabId: 'tab-1', worktreeId: 'wt-title' },
            { providerSession: { key: 'session_id', id } }
          )
        store.getState().dropAgentStatus(key)
      }
      const resolveSessionTitles = vi.fn(async (args: AiVaultSessionTitlesArgs) => ({
        titles: args.requests.map(({ agent, sessionId }) => ({
          agent,
          sessionId,
          title: sessionId === 'conversation-a' ? 'First conversation' : 'Second conversation',
          kind: 'named' as const
        }))
      }))
      const stop = startAiVaultTabTitleSync({
        getState: store.getState,
        subscribe: store.subscribe,
        resolveSessionTitles
      })
      try {
        await vi.waitFor(() =>
          expect(store.getState().tabsByWorktree['wt-title'][0].aiVaultTitle?.title).toBe(
            'First conversation'
          )
        )
        if (change === 'close') {
          store.getState().dropAgentStatus(paneA, { paneRemoved: true })
        } else if (change === 'authority retirement') {
          store.getState().retireAgentPaneAuthority(paneA)
        } else if (change === 'providerless successor') {
          store
            .getState()
            .setAgentStatus(
              paneA,
              { state: 'working', prompt: 'new task', agentType: 'codex' },
              undefined,
              { updatedAt: 2000, stateStartedAt: 2000, turnStartedAt: 2000 },
              { tabId: 'tab-1', worktreeId: 'wt-title' }
            )
        }
        if (change === 'close' || change === 'placement prune') {
          store.getState().setTabLayout('tab-1', {
            ...layout,
            root: removeLayoutLeaf(layout.root, a)
          })
        }
        await vi.waitFor(() =>
          expect(store.getState().tabsByWorktree['wt-title'][0].aiVaultTitle).toMatchObject({
            agent: 'codex',
            sessionId: 'conversation-b',
            title: 'Second conversation'
          })
        )
        expect(resolveTerminalTabTitle(store.getState().tabsByWorktree['wt-title'][0], false)).toBe(
          'Second conversation'
        )
      } finally {
        stop()
      }
    }
  )
})
