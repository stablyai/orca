import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { getRendererTitleLog, installRendererTitleLog } from './helpers/terminal-title-log'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type NotificationDispatch = {
  source?: string
  terminalTitle?: string
}

async function emitOscTitle(page: Page, ptyId: string, title: string) {
  await sendToTerminal(page, ptyId, `printf '\\033]0;${title}\\007'\r`)
}

async function installMainProcessNotificationDispatchSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as {
      __notificationDispatchLog?: NotificationDispatch[]
      __notificationDispatchSpyInstalled?: boolean
    }
    if (g.__notificationDispatchSpyInstalled) {
      return
    }
    g.__notificationDispatchLog = []
    g.__notificationDispatchSpyInstalled = true
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (_event: unknown, args: NotificationDispatch) => {
      g.__notificationDispatchLog!.push(args)
      return { delivered: true }
    })
  })
}

async function getNotificationDispatches(
  app: ElectronApplication
): Promise<NotificationDispatch[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __notificationDispatchLog?: NotificationDispatch[] }
    return g.__notificationDispatchLog ?? []
  })
}

test.describe('Droid notifications', () => {
  test('Factory Droid needs-input native title does not dispatch a task-complete notification', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    // Why: contextBridge freezes window.api, so notification invokes must be
    // observed in Electron's main process rather than monkey-patched renderer-side.
    await installMainProcessNotificationDispatchSpy(electronApp)
    await installRendererTitleLog(orcaPage)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `__DROID_NOTIFY_READY_${Date.now()}__`
    await sendToTerminal(orcaPage, ptyId, `printf '${marker}\\n'\r`)
    await waitForTerminalOutput(orcaPage, marker)

    await emitOscTitle(orcaPage, ptyId, '⠋ Droid')
    await emitOscTitle(orcaPage, ptyId, 'Factory Droid needs input')

    await expect
      .poll(
        async () => (await getRendererTitleLog(orcaPage)).includes('Factory Droid needs input'),
        {
          timeout: 10_000,
          message: 'Factory Droid marker title did not land'
        }
      )
      .toBe(true)

    // Why: Factory Droid can show this title while Execute is still running
    // (for example `sleep 180`); hook events own Droid status, not this title.
    await orcaPage.waitForTimeout(500)
    const dispatches = await getNotificationDispatches(electronApp)
    expect(dispatches).toEqual([])
  })
})
