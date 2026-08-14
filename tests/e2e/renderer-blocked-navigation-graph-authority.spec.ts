import { test, expect } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeStatus } from '../../src/shared/runtime-types'
import { waitForSessionReady } from './helpers/store'

type NavigationProbe = {
  startedLoading: number
  finishedLoading: number
  stoppedLoading: number
}

declare global {
  var __blockedNavigationProbe: NavigationProbe | undefined
}

test('blocked navigation preserves the renderer document and graph authority', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const before = (await client.call<RuntimeStatus>('status.get')).result

  await electronApp.evaluate(({ BrowserWindow, shell }) => {
    shell.openExternal = async () => undefined
    const probe = { startedLoading: 0, finishedLoading: 0, stoppedLoading: 0 }
    globalThis.__blockedNavigationProbe = probe
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    contents.on('did-start-loading', () => probe.startedLoading++)
    contents.on('did-finish-load', () => probe.finishedLoading++)
    contents.on('did-stop-loading', () => probe.stoppedLoading++)
  })
  await orcaPage.evaluate(() => {
    ;(window as unknown as { __blockedNavigationCanary: string }).__blockedNavigationCanary =
      'alive'
    const anchor = document.createElement('a')
    anchor.href = 'https://example.invalid/blocked'
    document.body.append(anchor)
    anchor.click()
  })

  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__blockedNavigationProbe))
    .toMatchObject({ startedLoading: 1, finishedLoading: 0, stoppedLoading: 1 })
  expect(
    await orcaPage.evaluate(
      () => (window as unknown as { __blockedNavigationCanary?: string }).__blockedNavigationCanary
    )
  ).toBe('alive')
  await expect
    .poll(async () => {
      const status = (await client.call<RuntimeStatus>('status.get')).result
      return {
        graphStatus: status.graphStatus,
        rendererGraphEpoch: status.rendererGraphEpoch,
        authoritativeWindowId: status.authoritativeWindowId
      }
    })
    .toEqual({
      graphStatus: 'ready',
      rendererGraphEpoch: before.rendererGraphEpoch,
      authoritativeWindowId: before.authoritativeWindowId
    })
})
