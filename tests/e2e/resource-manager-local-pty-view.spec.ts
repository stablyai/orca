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

for (const { theme, sessionCount, viewportHeight } of [
  { theme: 'dark', sessionCount: 1_000, viewportHeight: 900 },
  { theme: 'light', sessionCount: 1_000, viewportHeight: 900 },
  { theme: 'dark', sessionCount: 20, viewportHeight: 500 },
  { theme: 'light', sessionCount: 10_000, viewportHeight: 500 }
] as const) {
  test(`local PTY review and checked confirmation with ${sessionCount} sessions (${theme}, ${viewportHeight}px)`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: viewportHeight })
    await electronApp.evaluate(({ ipcMain }, sessionCount) => {
      const rows = Array.from({ length: sessionCount }, (_, index) => ({
        id: `local-pty-${String(index).padStart(4, '0')}`,
        incarnationId: `incarnation-${index}`,
        title: `Terminal ${index}`,
        ...(index === sessionCount - 1 ? { foregroundProcess: 'node' } : {}),
        cwd: `/workspace/folder-${index}`,
        agentOwnership: index === 0 ? 'unknown' : 'absent',
        fencedTermination: index !== sessionCount - 2
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
    }, sessionCount)
    await makeResourceManagerFixtureVisible(electronApp, orcaPage)
    await orcaPage.evaluate(async (theme) => {
      await window.__store!.getState().updateSettingsOrThrow({ theme })
    }, theme)
    await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
    const popover = orcaPage.locator('[data-slot="popover-content"]').filter({
      has: orcaPage.getByRole('tab', { name: 'Resources', exact: true })
    })
    const resourcesHeight = await popover.evaluate((element) => element.clientHeight)
    const listStarted = performance.now()
    await orcaPage.getByRole('tab', { name: 'PTYs', exact: true }).click()
    await expect(
      orcaPage.getByText(
        `${sessionCount} Orca PTYs on this computer · ${sessionCount} without a tab`,
        { exact: true }
      )
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
    await expect
      .poll(() => popover.evaluate((element) => element.clientHeight))
      .toBe(resourcesHeight)
    await expect
      .poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true)
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const unsupportedEnd = panel.getByRole('button', {
      name: `End Terminal ${sessionCount - 2}`,
      exact: true
    })
    await expect(unsupportedEnd).toBeDisabled()
    await unsupportedEnd.locator('..').hover()
    await expect(orcaPage.getByRole('tooltip', { name: /^End is unavailable/ })).toContainText(
      'End is unavailable for this terminal. Its host does not support the required safety checks.'
    )
    const details = panel.getByRole('button', {
      name: `Details for Terminal ${sessionCount - 1}`,
      exact: true
    })
    await details.focus()
    await orcaPage.keyboard.press('Enter')
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    const lastSessionId = `local-pty-${String(sessionCount - 1).padStart(4, '0')}`
    await expect(panel.locator('dl').getByText(lastSessionId, { exact: true })).toBeVisible()
    await expect(
      panel.locator('dl').getByText(`incarnation-${sessionCount - 1}`, { exact: true })
    ).toBeVisible()
    await expect(panel.locator('dl').getByText('Unavailable', { exact: true })).toHaveCount(2)
    await panel.getByRole('button', { name: 'Copy Orca session ID', exact: true }).click()
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(lastSessionId)
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
    for (let index = 1; index <= Math.min(30, sessionCount - 3); index++) {
      await orcaPage.keyboard.press('Tab')
      await orcaPage.keyboard.press('Tab')
      const terminal = orcaPage.getByRole('button', { name: `End Terminal ${index}`, exact: true })
      await expect(terminal).toBeFocused()
      await expect(terminal).toBeInViewport()
    }
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const lastTerminal = body.getByRole('button', {
      name: `End Terminal ${sessionCount - 1}`,
      exact: true
    })
    await expect(lastTerminal).toBeInViewport()
    console.info(JSON.stringify({ theme, rows: sessionCount, listMs }))
    await expect(
      body.getByText(`Last seen process: node · /workspace/folder-${sessionCount - 1}`, {
        exact: true
      })
    ).toBeVisible()
    const after = await electronApp.evaluate(() => {
      if (!globalThis.__ptyViewCounts) {
        throw new Error('PTY view counters missing')
      }
      return globalThis.__ptyViewCounts
    })
    expect(after.listing).toBe(before.listing)
    expect(after.metrics).toBe(before.metrics)
    await lastTerminal.click()
    await expect(
      orcaPage.getByRole('heading', { name: `End Terminal ${sessionCount - 1}?` })
    ).toBeVisible()
    await expect(
      orcaPage
        .getByRole('dialog', { name: `End Terminal ${sessionCount - 1}?` })
        .getByText(`/workspace/folder-${sessionCount - 1}`, { exact: true })
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
        id: lastSessionId,
        expectedIncarnationId: `incarnation-${sessionCount - 1}`,
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
        rows: sessionCount,
        listingCalls: before.listing,
        metricCalls: before.metrics
      }),
      contentType: 'application/json'
    })
  })
}
