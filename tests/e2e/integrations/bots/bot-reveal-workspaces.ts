// Bot "Reveal current" specs' workspace seeds: the repo's secondary worktree as a bot's worker, and an
// eligible Send to agent target in it.
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

/** The seeded secondary worktree, once its host has sent the row's instance: the lineage record
 *  must name it to place the row. */
export async function secondaryWorktree(page: Page, repoPath: string) {
  const read = () =>
    page.evaluate((repoPath) => {
      const state = window.__store!.getState()
      const repo = state.repos.find((candidate) => candidate.path === repoPath)
      const worktree = repo
        ? state.worktreesByRepo[repo.id]?.find((row) => row.branch === 'refs/heads/e2e-secondary')
        : undefined
      return repo && worktree?.instanceId
        ? { repoId: repo.id, worktreeId: worktree.id, instanceId: worktree.instanceId }
        : null
    }, repoPath)
  await expect.poll(read, { message: 'Seeded secondary worktree with its instance' }).not.toBeNull()
  return (await read())!
}

/** A working agent in a live terminal of the workspace, and an unsent diff note, so "Send notes to
 *  an agent" has an eligible target there (as agent-send-picker-reveal.spec.ts seeds one). */
export async function seedSendTarget(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(async (target) => {
    const store = window.__store!
    const state = store.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((row) => row.id === target)
    if (!worktree) {
      throw new Error('Send target workspace missing')
    }
    const now = Date.now()
    const noted = await state.updateWorktreeMeta(target, {
      diffComments: [
        {
          id: 'reveal-send-note',
          worktreeId: target,
          filePath: 'README.md',
          source: 'diff' as const,
          lineNumber: 1,
          body: 'Check the login redirect',
          side: 'modified' as const,
          createdAt: now
        }
      ]
    })
    if (!noted.ok) {
      throw new Error(`Writing the note failed: ${noted.error}`)
    }
    const tabId = 'reveal-send-agent-tab'
    const leafId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const paneKey = `${tabId}:${leafId}`
    const { id: ptyId } = await window.api.pty.spawn({
      cols: 80,
      rows: 24,
      cwd: worktree.path,
      worktreeId: target,
      tabId,
      leafId
    })
    state.setRightSidebarTab('source-control')
    state.setRightSidebarOpen(true)
    const current = store.getState()
    store.setState({
      tabsByWorktree: {
        ...current.tabsByWorktree,
        [target]: [
          ...(current.tabsByWorktree[target] ?? []),
          {
            id: tabId,
            worktreeId: target,
            ptyId,
            title: 'Claude',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: now
          }
        ]
      },
      terminalLayoutsByTabId: {
        ...current.terminalLayoutsByTabId,
        [tabId]: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: ptyId }
        }
      },
      ptyIdsByTabId: { ...current.ptyIdsByTabId, [tabId]: [ptyId] },
      agentStatusByPaneKey: current.agentStatusByPaneKey.replace([
        [
          paneKey,
          {
            state: 'working',
            prompt: 'Check the login redirect',
            updatedAt: now,
            stateStartedAt: now,
            agentType: 'claude',
            paneKey,
            worktreeId: target,
            stateHistory: []
          }
        ]
      ])
    })
  }, worktreeId)
}
