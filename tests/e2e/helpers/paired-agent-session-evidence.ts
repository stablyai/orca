import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import type { RuntimeTerminalSummary } from '../../../src/shared/runtime-types'

export type TimedClientResult<TResult> = {
  startedAt: number
  completedAt: number
  result: TResult
}

export async function callAgentSessionClient<TResult>(
  page: Page,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

export async function callAgentSessionClientAt<TResult>(
  page: Page,
  startAt: number,
  method: string,
  params: unknown
): Promise<TimedClientResult<TResult>> {
  return page.evaluate(
    async ({ startAt, method, params }) => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())))
      const startedAt = Date.now()
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return { startedAt, completedAt: Date.now(), result: response.result }
    },
    { startAt, method, params }
  ) as Promise<TimedClientResult<TResult>>
}

export async function activePairedWorktreeId(page: Page): Promise<string> {
  const worktreeId = await page.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('Renderer has no active worktree')
  }
  return worktreeId
}

export async function waitForPairedWorktree(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id),
          worktreeId
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
}

export async function listPairedTerminals(
  page: Page,
  worktreeId: string
): Promise<RuntimeTerminalSummary[]> {
  return (
    await callAgentSessionClient<{ terminals: RuntimeTerminalSummary[] }>(page, 'terminal.list', {
      worktree: `id:${worktreeId}`
    })
  ).terminals
}

export async function mirroredPairedTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

export async function activePairedTabId(page: Page, worktreeId: string): Promise<string | null> {
  return page.evaluate(
    (id) => window.__store?.getState().activeTabIdByWorktree[id] ?? null,
    worktreeId
  )
}

export async function pairedTerminalViewportText(page: Page, tabId: string): Promise<string> {
  return page.evaluate((id) => {
    const pane = window.__paneManagers?.get(id)?.getActivePane?.()
    if (!pane) {
      return ''
    }
    const buffer = pane.terminal.buffer.active
    return Array.from(
      { length: pane.terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    ).join('\n')
  }, tabId)
}
