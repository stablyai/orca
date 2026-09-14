import type { Page } from '@stablyai/playwright-test'

/**
 * Opens a terminal tab the way the tab bar does.
 *
 * The group id is required, not incidental: the real caller only ever invokes this with the group it
 * is opening into, and passing none lands the tab nowhere. That was invisible until tests/ got a
 * typecheck config, because a spec calling it with no argument still compiled.
 */
export async function openTerminalTabInActiveGroup(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree to open a terminal tab in')
    }
    const groupId = state.activeGroupIdByWorktree[worktreeId]
    if (!groupId) {
      throw new Error(`No active tab group for worktree ${worktreeId}`)
    }
    await state.openNewTerminalTabInActiveWorkspace(groupId)
  })
}
