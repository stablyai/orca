import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * The reported bug: Orca's managed Claude hooks were removed from
 * ~/.claude/settings.json while an agent was working. With no hook firing the
 * worktree dot fell through to the title heuristic, resolved 'active', and
 * rendered the same emerald dot as 'done' — a working agent looked finished.
 *
 * This drives the real renderer: seed a live Claude pane, flip the hook install
 * snapshot, and read the dot the sidebar actually paints.
 */

type DotProbe = {
  unverifiableDots: number
  dashedRings: number
  emeraldDots: number
}

const UNVERIFIABLE_TITLE = 'Status unavailable — agent hooks are missing or unreadable'

async function seedLiveClaudePane(
  page: Parameters<typeof waitForActiveWorktree>[0],
  worktreeId: string
): Promise<string> {
  return page.evaluate((wtId: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const state = store.getState()
    const existing = state.tabsByWorktree[wtId]?.[0]
    const tabId =
      existing?.id ??
      (() => {
        const created = state.createTab(wtId, undefined, undefined, {
          activate: false,
          id: 'hooks-unverifiable-tab'
        })
        return typeof created === 'string' ? created : created.id
      })()
    const next = store.getState()
    store.setState({
      // A live PTY plus a Claude launch identity: the shape the bug needs.
      ptyIdsByTabId: { ...next.ptyIdsByTabId, [tabId]: ['pty-hooks-unverifiable'] },
      tabsByWorktree: {
        ...next.tabsByWorktree,
        [wtId]: (next.tabsByWorktree[wtId] ?? []).map((entry) =>
          entry.id === tabId
            ? // A prompt-derived title with no spinner glyph — exactly what the
              // recording showed while the agent was mid-turn.
              { ...entry, launchAgent: 'claude', title: 'marabel@host: ~/repo' }
            : entry
        )
      },
      // No hook rows at all: the tell that nothing ever reported for this pane.
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    })
    return tabId
  }, worktreeId)
}

async function reportClaudeDone(
  page: Parameters<typeof waitForActiveWorktree>[0],
  tabId: string
): Promise<void> {
  await page.evaluate((id: string) => {
    const now = Date.now()
    window
      .__store!.getState()
      .setAgentStatus(
        `${id}:0`,
        { state: 'done', prompt: 'Finished the previous turn', agentType: 'claude' },
        'Claude',
        { updatedAt: now, stateStartedAt: now }
      )
  }, tabId)
}

async function setClaudeHookState(
  page: Parameters<typeof waitForActiveWorktree>[0],
  state: 'installed' | 'not_installed'
): Promise<void> {
  await page.evaluate((hookState: string) => {
    window.__store!.getState().setAgentHookInstallStatuses([
      {
        agent: 'claude',
        state: hookState,
        configPath: '/home/user/.claude/settings.json',
        managedHooksPresent: hookState === 'installed',
        detail: null
      }
    ])
  }, state)
}

async function readDots(page: Parameters<typeof waitForActiveWorktree>[0]): Promise<DotProbe> {
  return page.evaluate((title: string) => {
    const sidebar = document.body
    return {
      unverifiableDots: sidebar.querySelectorAll(`span[title="${title}"]`).length,
      dashedRings: sidebar.querySelectorAll('.lucide-circle-dashed').length,
      emeraldDots: sidebar.querySelectorAll('.bg-emerald-500').length
    }
  }, UNVERIFIABLE_TITLE)
}

test('surfaces an unverifiable dot when the managed Claude hooks are gone', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await seedLiveClaudePane(orcaPage, worktreeId)

  // Healthy hooks first: the sidebar must show no unverifiable dot at all.
  await setClaudeHookState(orcaPage, 'installed')
  await expect.poll(async () => (await readDots(orcaPage)).unverifiableDots).toBe(0)
  const healthy = await readDots(orcaPage)
  expect(healthy.emeraldDots).toBeGreaterThan(0)

  // Now remove them, the way the bug did.
  await setClaudeHookState(orcaPage, 'not_installed')

  await expect.poll(async () => (await readDots(orcaPage)).unverifiableDots).toBeGreaterThan(0)
  const blind = await readDots(orcaPage)
  expect(blind.dashedRings).toBeGreaterThan(0)
  // The green dot the bug showed is gone from the card that lost its hooks.
  expect(blind.emeraldDots).toBeLessThan(healthy.emeraldDots)
})

test('surfaces an unverifiable dot when hooks disappear after a done row', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const tabId = await seedLiveClaudePane(orcaPage, worktreeId)

  await setClaudeHookState(orcaPage, 'installed')
  await reportClaudeDone(orcaPage, tabId)
  await expect.poll(async () => (await readDots(orcaPage)).unverifiableDots).toBe(0)

  await setClaudeHookState(orcaPage, 'not_installed')

  await expect.poll(async () => (await readDots(orcaPage)).unverifiableDots).toBeGreaterThan(0)
  expect((await readDots(orcaPage)).dashedRings).toBeGreaterThan(0)
})
