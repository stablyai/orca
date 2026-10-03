import type { Page } from '@stablyai/playwright-test'
import { toHostSessionTabId } from '../../../src/shared/terminal-surface-id'
import { expect } from './orca-app'

export async function expectHostTerminalsUnmounted(
  hostPage: Page | undefined,
  activeWorktreeId: string,
  remoteTabs: readonly { tabId: string }[]
): Promise<void> {
  if (!hostPage) {
    return
  }
  await expect
    .poll(
      () =>
        hostPage.evaluate(
          (tabIds) => ({
            activeWorktreeId: window.__store?.getState().activeWorktreeId,
            mountedCount: tabIds.filter((tabId) => window.__paneManagers?.has(tabId)).length
          }),
          remoteTabs.map(({ tabId }) => toHostSessionTabId(tabId))
        ),
      { timeout: 30_000 }
    )
    .toEqual({ activeWorktreeId, mountedCount: 0 })
}
