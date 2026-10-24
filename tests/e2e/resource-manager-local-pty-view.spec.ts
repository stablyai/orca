import { expect, test } from './helpers/orca-app'
import { makeResourceManagerFixtureVisible } from './helpers/resource-manager-visible-fixture'
import { waitForSessionReady } from './helpers/store'

type PtyViewCounts = { listing: number; metrics: number; kills?: unknown[] }

declare global {
  var __ptyViewCounts: PtyViewCounts | undefined
}

test.use({ seedTestRepo: false })

test('a real hidden window performs no Resource Manager diagnostics and vetoes forced tagged calls', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await electronApp.evaluate(({ ipcMain }) => {
    type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's private invoke registry is checked before wrapping the real handlers.
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })
      ._invokeHandlers
    const counts: PtyViewCounts = { listing: 0, metrics: 0 }
    globalThis.__ptyViewCounts = counts
    for (const [channel, key] of [
      ['pty:listSessions', 'listing'],
      ['memory:getSnapshot', 'metrics']
    ] as const) {
      const original = handlers.get(channel)
      if (!original) {
        throw new Error(`Missing ${channel}`)
      }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, ...args) => {
        if (
          args.some((value) => value && typeof value === 'object' && 'resourceManagerView' in value)
        ) {
          counts[key]++
        }
        return original(event, ...args)
      })
    }
  })
  await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
  await orcaPage.getByRole('tab', { name: 'PTYs', exact: true }).click()
  await expect(orcaPage.getByText('Loading terminals…', { exact: true })).toBeVisible()
  await orcaPage.waitForTimeout(2_100)
  expect(
    await electronApp.evaluate(() => {
      if (!globalThis.__ptyViewCounts) {
        throw new Error('PTY view counters missing')
      }
      return globalThis.__ptyViewCounts
    })
  ).toEqual({ listing: 0, metrics: 0 })
  expect(await orcaPage.evaluate(() => window.api.memory.resourceWindowVisible())).toBe(false)
  const veto = await orcaPage.evaluate(async () => {
    try {
      await window.api.pty.listSessions({ connectionId: null }, { resourceManagerView: true })
      return 'unexpected success'
    } catch (error) {
      return String(error)
    }
  })
  expect(veto).toContain('view_not_visible')
  await expect(orcaPage.getByText(/Unverifiable: local terminals/)).toHaveCount(0)
})

for (const theme of ['dark', 'light'] as const) {
  test(`local PTY review and checked confirmation with 1,000 sessions (${theme})`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 900 })
    await electronApp.evaluate(({ ipcMain }) => {
      const rows = Array.from({ length: 1_000 }, (_, index) => ({
        id: `local-pty-${String(index).padStart(4, '0')}`,
        incarnationId: `incarnation-${index}`,
        title: `Terminal ${index}`,
        ...(index === 999 ? { foregroundProcess: 'node' } : {}),
        cwd: `/workspace/folder-${index}`,
        agentOwnership: index === 0 ? 'unknown' : 'absent',
        fencedTermination: index !== 998
      }))
      const counts: Required<PtyViewCounts> = {
        listing: 0,
        metrics: 0,
        kills: []
      }
      globalThis.__ptyViewCounts = counts
      for (const channel of [
        'pty:listSessions',
        'memory:getSnapshot',
        'memory:resourceWindowVisible',
        'pty:killFenced'
      ]) {
        ipcMain.removeHandler(channel)
      }
      ipcMain.handle('memory:resourceWindowVisible', () => true)
      ipcMain.handle('memory:getSnapshot', () => {
        counts.metrics++
        return null
      })
      ipcMain.handle('pty:listSessions', (_event, scope) => {
        counts.listing++
        if (scope?.connectionId !== null) {
          return []
        }
        return rows
      })
      ipcMain.handle('pty:killFenced', (_event, request) => {
        counts.kills.push(request)
        return { outcome: 'refused', reason: 'attached' }
      })
    })
    await makeResourceManagerFixtureVisible(electronApp, orcaPage)
    await orcaPage.evaluate(async (theme) => {
      await window.__store!.getState().updateSettingsOrThrow({ theme })
    }, theme)
    await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
    const listStarted = performance.now()
    await orcaPage.getByRole('tab', { name: 'PTYs', exact: true }).click()
    await expect(
      orcaPage.getByText('1000 Orca PTYs on this computer · 1000 without a tab', {
        exact: true
      })
    ).toBeVisible()
    const listMs = performance.now() - listStarted
    const before = await electronApp.evaluate(() => {
      if (!globalThis.__ptyViewCounts) {
        throw new Error('PTY view counters missing')
      }
      return globalThis.__ptyViewCounts
    })
    const panel = orcaPage.getByRole('tabpanel', { name: /^PTYs/ })
    await expect(panel.getByRole('searchbox')).toHaveCount(0)
    await expect(panel.getByRole('combobox')).toHaveCount(0)
    const body = orcaPage.locator('[data-resource-pty-body]')
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const unsupportedEnd = panel.getByRole('button', {
      name: 'End Terminal 998',
      exact: true
    })
    await expect(unsupportedEnd).toBeDisabled()
    await unsupportedEnd.locator('..').hover()
    await expect(orcaPage.getByRole('tooltip', { name: /^End is unavailable/ })).toContainText(
      'End is unavailable for this terminal. Its host does not support the required safety checks.'
    )
    const details = panel.getByRole('button', { name: 'Details for Terminal 999', exact: true })
    await details.focus()
    await orcaPage.keyboard.press('Enter')
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.locator('dl').getByText('local-pty-0999', { exact: true })).toBeVisible()
    await expect(panel.locator('dl').getByText('incarnation-999', { exact: true })).toBeVisible()
    await expect(panel.locator('dl').getByText('Unavailable', { exact: true })).toHaveCount(2)
    await panel.getByRole('button', { name: 'Copy Orca session ID', exact: true }).click()
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'local-pty-0999'
    )
    await orcaPage.screenshot({
      path: testInfo.outputPath(`local-pty-details-${theme}.png`),
      animations: 'disabled'
    })
    await body.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(panel.getByRole('button', { name: 'End Terminal 0', exact: true })).toBeVisible()
    const firstTerminal = orcaPage.getByRole('button', { name: 'End Terminal 0', exact: true })
    await expect(firstTerminal).toBeVisible()
    expect(await orcaPage.getByRole('button', { name: /^End Terminal/ }).count()).toBeLessThan(50)
    await firstTerminal.focus()
    for (let index = 1; index <= 30; index++) {
      await orcaPage.keyboard.press('Tab')
      await orcaPage.keyboard.press('Tab')
      const terminal = orcaPage.getByRole('button', { name: `End Terminal ${index}`, exact: true })
      await expect(terminal).toBeFocused()
      await expect(terminal).toBeInViewport()
    }
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const lastTerminal = body.getByRole('button', { name: 'End Terminal 999', exact: true })
    await expect(lastTerminal).toBeVisible()
    console.info(JSON.stringify({ theme, rows: 1_000, listMs }))
    await expect(body.getByText('Last seen process: node', { exact: false })).toBeVisible()
    await expect(body.getByText('/workspace/folder-999', { exact: false })).toBeVisible()
    const after = await electronApp.evaluate(() => {
      if (!globalThis.__ptyViewCounts) {
        throw new Error('PTY view counters missing')
      }
      return globalThis.__ptyViewCounts
    })
    expect(after.listing).toBe(before.listing)
    expect(after.metrics).toBe(before.metrics)
    await lastTerminal.click()
    await expect(orcaPage.getByRole('heading', { name: 'End Terminal 999?' })).toBeVisible()
    await expect(
      orcaPage
        .getByRole('dialog', { name: 'End Terminal 999?' })
        .getByText('/workspace/folder-999', { exact: true })
    ).toBeVisible()
    expect(
      (
        await electronApp.evaluate(() => {
          if (!globalThis.__ptyViewCounts) {
            throw new Error('PTY view counters missing')
          }
          return globalThis.__ptyViewCounts
        })
      ).kills
    ).toHaveLength(0)
    await orcaPage.getByRole('button', { name: 'End terminal', exact: true }).click()
    await expect(
      orcaPage.getByText(
        'A client is now attached to this terminal. Refresh before trying again.',
        { exact: true }
      )
    ).toBeVisible()
    expect(
      (
        await electronApp.evaluate(() => {
          if (!globalThis.__ptyViewCounts) {
            throw new Error('PTY view counters missing')
          }
          return globalThis.__ptyViewCounts
        })
      ).kills
    ).toEqual([
      {
        id: 'local-pty-0999',
        expectedIncarnationId: 'incarnation-999',
        requireNoAgentOwner: true,
        requireUnattached: true
      }
    ])
    await orcaPage.screenshot({
      path: testInfo.outputPath(`local-ptys-${theme}.png`),
      animations: 'disabled'
    })
    await testInfo.attach(`local-ptys-${theme}`, {
      path: testInfo.outputPath(`local-ptys-${theme}.png`),
      contentType: 'image/png'
    })
    await testInfo.attach('interaction-measurement', {
      body: JSON.stringify({
        rows: 1_000,
        listingCalls: before.listing,
        metricCalls: before.metrics
      }),
      contentType: 'application/json'
    })
  })
}
