import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { registerRuntimeTerminalTab } from './mounted-terminal-tab-registry'
import { makeAgentStatusEntry, makeState } from './sync-runtime-graph-test-harness'
import '../../../shared/constants'
import type { AppState } from '../store/types'

function registerMobileTestSurface(args: {
  tabId: string
  leafIds: string[]
  activeLeafId: string
  launchAgentLeafId: string | null
}): {
  unregister: () => void
  setTopology: (leafIds: string[], activeLeafId: string) => void
} {
  let leafIds = [...args.leafIds]
  let activeLeafId = args.activeLeafId
  const paneIdByLeafId = new Map(args.leafIds.map((leafId, index) => [leafId, index + 1]))
  const manager = {
    getPanes: () => leafIds.map((leafId) => ({ id: paneIdByLeafId.get(leafId)!, leafId })),
    getActivePane: () => {
      const paneId = paneIdByLeafId.get(activeLeafId)
      return !paneId || !leafIds.includes(activeLeafId)
        ? null
        : { id: paneId, leafId: activeLeafId }
    },
    getLeafId: (paneId: number) =>
      leafIds.find((leafId) => paneIdByLeafId.get(leafId) === paneId) ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      leafIds.includes(leafId) ? (paneIdByLeafId.get(leafId) ?? null) : null
  }
  return {
    unregister: registerRuntimeTerminalTab({
      tabId: args.tabId,
      worktreeId: 'wt-1',
      getManager: () => manager as never,
      getContainer: () => null,
      getPtyIdForPane: (paneId) => `pty-${paneId}`,
      getTabWideAgentHintLeafId: () => args.launchAgentLeafId
    }),
    setTopology: (nextLeafIds, nextActiveLeafId) => {
      leafIds = [...nextLeafIds]
      activeLeafId = nextActiveLeafId
    }
  }
}

describe('buildMobileSessionTabSnapshots', () => {
  it('keeps agent identity and launch context off a plain sibling leaf', () => {
    const agentLeafId = '11111111-1111-4111-8111-111111111111'
    const shellLeafId = '22222222-2222-4222-8222-222222222222'
    const surface = registerMobileTestSurface({
      tabId: 'term-1',
      leafIds: [agentLeafId, shellLeafId],
      activeLeafId: shellLeafId,
      launchAgentLeafId: agentLeafId
    })
    try {
      const state = makeState({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'term-1',
              title: 'Codex working',
              customTitle: null,
              launchAgent: 'codex',
              generatedTitle: 'Inspect the image',
              aiVaultTitle: {
                agent: 'codex',
                sessionId: 'session-1',
                title: '[Image #1] Inspect the image'
              }
            }
          ]
        } as unknown as AppState['tabsByWorktree'],
        terminalLayoutsByTabId: {
          'term-1': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: agentLeafId },
              second: { type: 'leaf', leafId: shellLeafId }
            },
            activeLeafId: shellLeafId,
            expandedLeafId: null
          }
        } as AppState['terminalLayoutsByTabId'],
        runtimePaneTitlesByTabId: {
          'term-1': { 1: 'Codex working', 2: 'zsh' }
        },
        agentStatusByPaneKey: {
          [`term-1:${agentLeafId}`]: makeAgentStatusEntry({
            paneKey: `term-1:${agentLeafId}`,
            agentType: 'codex',
            terminalTitle: 'Codex working'
          })
        },
        nativeChatLaunchDraftByTabId: {
          'term-1': {
            tabId: 'term-1',
            agent: 'codex',
            text: 'inspect this image',
            createdAt: 1
          }
        }
      })

      const tabs = buildMobileSessionTabSnapshots(state)[0]?.tabs ?? []
      const agentLeaf = tabs.find((tab) => tab.type === 'terminal' && tab.leafId === agentLeafId)
      const shellLeaf = tabs.find((tab) => tab.type === 'terminal' && tab.leafId === shellLeafId)

      expect(agentLeaf).toMatchObject({
        title: 'Codex working',
        agentStatus: { agentType: 'codex' }
      })
      expect(shellLeaf).toMatchObject({ title: 'zsh' })
      expect(shellLeaf).not.toHaveProperty('agentStatus')
      expect(shellLeaf).not.toHaveProperty('launchAgent')
      expect(shellLeaf).not.toHaveProperty('launchDraft')
      expect(shellLeaf).not.toHaveProperty('quickCommandLabel')
    } finally {
      surface.unregister()
    }
  })

  it('keeps split-leaf ownership stable across reorder and active-leaf changes', () => {
    const agentLeafId = '55555555-5555-4555-8555-555555555555'
    const shellLeafId = '66666666-6666-4666-8666-666666666666'
    const surface = registerMobileTestSurface({
      tabId: 'term-reorder',
      leafIds: [agentLeafId, shellLeafId],
      activeLeafId: agentLeafId,
      launchAgentLeafId: agentLeafId
    })
    try {
      surface.setTopology([shellLeafId, agentLeafId], shellLeafId)
      const state = makeState({
        activeTabId: 'term-reorder',
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'term-reorder',
              title: '[Image #1] Wrong scope',
              customTitle: null,
              launchAgent: 'codex'
            }
          ]
        } as unknown as AppState['tabsByWorktree'],
        terminalLayoutsByTabId: {
          'term-reorder': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: shellLeafId },
              second: { type: 'leaf', leafId: agentLeafId }
            },
            activeLeafId: shellLeafId,
            expandedLeafId: null
          }
        } as AppState['terminalLayoutsByTabId'],
        runtimePaneTitlesByTabId: {
          'term-reorder': { 1: 'Codex working', 2: 'fish' }
        },
        agentStatusByPaneKey: {
          [`term-reorder:${agentLeafId}`]: makeAgentStatusEntry({
            paneKey: `term-reorder:${agentLeafId}`,
            terminalTitle: 'Codex working'
          })
        }
      })

      const tabs = buildMobileSessionTabSnapshots(state)[0]?.tabs ?? []
      expect(tabs).toMatchObject([
        { leafId: shellLeafId, title: 'fish', isActive: true },
        { leafId: agentLeafId, title: 'Codex working', isActive: false }
      ])
      expect(tabs[0]).not.toHaveProperty('agentStatus')
      expect(tabs[1]).toHaveProperty('agentStatus.agentType', 'codex')
    } finally {
      surface.unregister()
    }
  })
})
