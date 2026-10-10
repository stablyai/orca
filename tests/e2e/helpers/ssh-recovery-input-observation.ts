import type { Page, TestInfo } from '@playwright/test'
import type { RuntimeTerminalListResult } from '../../../src/shared/runtime-types'

export async function attachSshRecoveryInputObservation(
  page: Page,
  testInfo: TestInfo,
  targetId: string,
  originalPtyId: string,
  label: string
): Promise<void> {
  const observation = await page.evaluate(
    async ({ targetId, originalPtyId }) => {
      const state = window.__store?.getState()
      const panes = [...(window.__paneManagers?.entries() ?? [])].flatMap(([tabId, manager]) =>
        manager.getPanes().map((pane) => ({
          tabId,
          leafId: pane.leafId,
          ptyId: pane.container.dataset.ptyId,
          active: manager.getActivePane()?.id === pane.id
        }))
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const runtime = await Promise.race([
          window.api.runtime
            .call({ method: 'terminal.list', params: { limit: 50, includeVisualLayouts: false } })
            .then((response) =>
              response.ok
                ? { terminals: (response.result as RuntimeTerminalListResult).terminals }
                : { error: response.error }
            ),
          new Promise<{ error: string }>((resolve) => {
            timer = setTimeout(() => resolve({ error: 'Observation timed out' }), 1000)
          })
        ])
        return {
          originalPtyId,
          authority: state?.sshConnectionStates.get(targetId),
          activeWorktreeId: state?.activeWorktreeId,
          panes,
          runtime
        }
      } finally {
        clearTimeout(timer)
      }
    },
    { targetId, originalPtyId }
  )
  await testInfo.attach(`ssh-input-${label}.json`, {
    body: JSON.stringify(observation, null, 2),
    contentType: 'application/json'
  })
}
