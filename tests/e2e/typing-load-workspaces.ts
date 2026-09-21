import type { Page } from '@stablyai/playwright-test'
import { switchToWorktree } from './helpers/store'
import {
  ensureActiveWorktreePaneLoad,
  type TerminalLoadPane
} from './artificial-opencode-pane-interactions'

export async function createTypingLoadWorkspaces(
  page: Page,
  firstWorktreeId: string,
  paneCount: number,
  workspaceCount: number,
  visitedWorkspaces: number,
  createdIds: string[]
): Promise<TerminalLoadPane[]> {
  const panes: TerminalLoadPane[] = []
  const count = Math.min(paneCount, workspaceCount)
  const visitedCount = Math.max(count, visitedWorkspaces)
  for (let index = 0; index < visitedCount; index++) {
    let worktreeId = firstWorktreeId
    if (index > 0) {
      worktreeId = await page.evaluate(
        async ({ firstWorktreeId, index }) => {
          const state = window.__store?.getState()
          const owner = Object.values(state?.worktreesByRepo ?? {})
            .flat()
            .find((row) => row.id === firstWorktreeId)
          if (!state || !owner) {
            throw new Error('Benchmark load repository is unavailable')
          }
          const result = await state.createWorktree(
            owner.repoId,
            `typing-load-${Date.now()}-${index}`,
            undefined,
            'skip'
          )
          return result.worktree.id
        },
        { firstWorktreeId, index }
      )
      createdIds.push(worktreeId)
    }
    await switchToWorktree(page, worktreeId)
    const loadIndex = index - (visitedCount - count)
    const countHere =
      loadIndex < 0 ? 1 : Math.floor(paneCount / count) + (loadIndex < paneCount % count ? 1 : 0)
    const mounted = await ensureActiveWorktreePaneLoad(page, countHere)
    if (loadIndex >= 0) {
      panes.push(...mounted)
    }
  }
  return panes
}

export async function removeTypingLoadWorkspaces(
  page: Page,
  createdIds: readonly string[]
): Promise<void> {
  for (const id of createdIds) {
    await page.evaluate(async (worktreeId) => {
      const result = await window.__store
        ?.getState()
        .removeWorktree({ id: worktreeId, executionHostId: null }, true)
      if (!result?.ok) {
        throw new Error(`Benchmark cleanup failed: ${result?.error ?? 'store unavailable'}`)
      }
    }, id)
  }
}
