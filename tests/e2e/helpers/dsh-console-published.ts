import { expect } from '@stablyai/playwright-test'
import { stripVTControlCharacters } from 'node:util'
import { focusActiveTerminalInput, getTerminalContent } from './terminal'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { AgentStartupPlan } from '../../../src/shared/tui-agent-startup'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult
} from '../../../src/shared/notification-settings-types'

export async function launchPublishedDshPlan(
  page: Page,
  worktreeId: string,
  plan: AgentStartupPlan
): Promise<string> {
  return page.evaluate(
    ({ worktreeId, plan }) => {
      const store = window.__store!.getState()
      return store.createTab(worktreeId, undefined, undefined, {
        launchAgent: 'dsh-console',
        pendingStartup: {
          command: plan.launchCommand,
          launchAgent: 'dsh-console',
          launchConfig: plan.launchConfig,
          ...(plan.env ? { env: plan.env } : {})
        }
      }).id
    },
    { worktreeId, plan }
  )
}

export type DshNotificationEvidence = {
  request: NotificationDispatchRequest
  result: NotificationDispatchResult
}

/** Observe the real dispatch result; preserve the production handler and native delivery. */
export async function observeDshNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain as unknown as {
      _invokeHandlers: Map<
        string,
        (
          event: unknown,
          request: NotificationDispatchRequest
        ) => NotificationDispatchResult | Promise<NotificationDispatchResult>
      >
    }
    const original = handlers._invokeHandlers.get('notifications:dispatch')
    if (!original) {
      throw new Error('Notification handler is not registered')
    }
    const root = globalThis as unknown as { __dshNotificationEvidence: DshNotificationEvidence[] }
    root.__dshNotificationEvidence = []
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle(
      'notifications:dispatch',
      async (event, request: NotificationDispatchRequest) => {
        const result = await original(event, request)
        root.__dshNotificationEvidence.push({ request, result })
        return result
      }
    )
  })
}

export async function readDshNotifications(
  app: ElectronApplication
): Promise<DshNotificationEvidence[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __dshNotificationEvidence?: DshNotificationEvidence[] })
        .__dshNotificationEvidence ?? []
  )
}

export async function submitDshInput(page: Page, input: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.type(input, { delay: 20 })
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(page, 100_000)))
    .toContain(input.slice(0, 35))
  await page.keyboard.press('Enter')
}
