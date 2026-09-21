import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export async function callPairedRuntime<TResult>(
  page: Page,
  selector: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ method, params, selector }) => {
      const response = await window.api.runtimeEnvironments.call({ selector, method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params, selector }
  ) as Promise<TResult>
}

export async function waitForPairedClientWorktree(
  page: Page,
  expectedId?: string
): Promise<string> {
  const read = (): Promise<string | null> =>
    page.evaluate(
      (id) =>
        window.__store
          ?.getState()
          .allWorktrees()
          .find((worktree) => !id || worktree.id === id)?.id ?? null,
      expectedId
    )
  await expect.poll(read, { timeout: 30_000 }).not.toBeNull()
  const worktreeId = await read()
  if (!worktreeId) {
    throw new Error('Paired client did not receive the host workspace')
  }
  return worktreeId
}
