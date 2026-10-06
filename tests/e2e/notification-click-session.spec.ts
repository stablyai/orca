import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  execInTerminal,
  waitForTerminalOutput
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'

// Keep OS banners hidden; emit clicks on the real Notification with its production handler.
async function clickRetainedNotification(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const notification = Reflect.get(globalThis, 'retainedProofNotification')
    if (!(notification instanceof Notification)) {
      throw new Error('No retained notification')
    }
    notification.emit('click')
  })
}

test('notification click opens the originating tab and keeps a closed session closed', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const targetWorkspace = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await createTerminalTabFromMenu(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 15000)
  await execInTerminal(orcaPage, ptyId, splitMarkerEchoCommand('ORIGINATING', '_SESSION'))
  await waitForTerminalOutput(orcaPage, 'ORIGINATING_SESSION')
  const originTabId = descriptor.paneKey.split(':')[0]
  if (!originTabId) {
    throw new Error('Missing origin tab')
  }

  await electronApp.evaluate(({ Notification }) => {
    Notification.prototype.show = function () {
      Reflect.set(globalThis, 'retainedProofNotification', this)
    }
  })
  await orcaPage.evaluate(async () => {
    const settings = await window.api.settings.get()
    await window.api.settings.set({
      notifications: {
        ...settings.notifications,
        enabled: true,
        suppressWhenFocused: false,
        customSoundId: 'system'
      }
    })
  })
  await createTerminalTabFromMenu(orcaPage)
  const anotherPtyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, anotherPtyId, 15000)
  await execInTerminal(orcaPage, anotherPtyId, splitMarkerEchoCommand('OTHER', '_SESSION'))
  await waitForTerminalOutput(orcaPage, 'OTHER_SESSION')
  const request = {
    source: 'test' as const,
    worktreeId: targetWorkspace,
    paneKey: descriptor.paneKey,
    executionHostId: 'local' as const,
    terminalTitle: 'Originating session'
  }
  expect(
    await orcaPage.evaluate((request) => window.api.notifications.dispatch(request), request)
  ).toEqual({ delivered: true })
  await orcaPage.screenshot({ path: testInfo.outputPath('live-before-click.png') })
  const baseline = process.env.ORCA_NOTIFICATION_CLICK_BASELINE === '1'
  const previousTabId = await orcaPage.evaluate(() => window.__store!.getState().activeTabId)
  const probe = await orcaPage.evaluateHandle(
    ({ originTabId, previousTabId }) => {
      const frames: {
        targetPresented: boolean
        previousPresented: boolean
        targetBufferContainsMarker: boolean
      }[] = []
      let running = true
      const presented = (tabId: string | null): boolean => {
        const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
        const element = pane?.container
        if (!element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false
        }
        const rect = element.getBoundingClientRect()
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < innerWidth &&
          rect.top < innerHeight
        )
      }
      const record = (): void => {
        const buffer = window.__paneManagers?.get(originTabId)?.getActivePane()?.terminal
          .buffer.active
        let text = ''
        if (buffer) {
          for (let row = 0; row < buffer.length; row++) {
            text += buffer.getLine(row)?.translateToString() ?? ''
          }
        }
        frames.push({
          targetPresented: presented(originTabId),
          previousPresented: presented(previousTabId),
          targetBufferContainsMarker: text.includes('ORIGINATING_SESSION')
        })
        if (running) {
          requestAnimationFrame(record)
        }
      }
      requestAnimationFrame(record)
      return {
        stop: () => {
          running = false
          return frames
        }
      }
    },
    { originTabId, previousTabId }
  )
  await orcaPage.waitForTimeout(700)
  await clickRetainedNotification(electronApp)
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeTabId))
    .toBe(originTabId)
  await waitForTerminalOutput(orcaPage, 'ORIGINATING_SESSION')
  await orcaPage.waitForTimeout(350)
  const frames = await probe.evaluate((probe) => probe.stop())
  await probe.dispose()
  if (!baseline) {
    const firstTargetFrame = frames.findIndex((frame) => frame.targetPresented)
    expect(firstTargetFrame).toBeGreaterThan(0)
    expect(frames[firstTargetFrame]?.targetBufferContainsMarker).toBe(true)
    expect(
      frames
        .slice(0, firstTargetFrame)
        .every((frame) => frame.previousPresented && !frame.targetPresented)
    ).toBe(true)
  }
  await testInfo.attach('notification handoff frames', {
    body: JSON.stringify(frames, null, 2),
    contentType: 'application/json'
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('live-after-click.png') })
  await orcaPage.waitForTimeout(900)

  // Retain a second notification, then remove every session in its workspace.
  expect(
    await orcaPage.evaluate((request) => window.api.notifications.dispatch(request), request)
  ).toEqual({ delivered: true })
  const tabIds = await orcaPage.evaluate(
    (worktreeId) =>
      (window.__store!.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
    targetWorkspace
  )
  for (const tabId of tabIds) {
    const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).first()
    await tab.hover()
    await tab.getByRole('button', { name: /^Close tab /i }).click()
    const confirmation = orcaPage.getByRole('button', { name: /^Stop and Close$/ })
    if (await confirmation.isVisible().catch(() => false)) {
      await confirmation.click()
    }
    await expect(tab).toHaveCount(0)
  }
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (worktreeId) => (window.__store!.getState().tabsByWorktree[worktreeId] ?? []).length,
        targetWorkspace
      )
    )
    .toBe(0)
  await orcaPage.evaluate((worktreeId) => {
    const state = window.__store!.getState()
    const other = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id !== worktreeId)
    if (!other) {
      throw new Error('Missing second workspace')
    }
    state.setActiveWorktree(other.id)
  }, targetWorkspace)
  await orcaPage.waitForTimeout(500)
  await orcaPage.screenshot({ path: testInfo.outputPath('closed-before-click.png') })
  await clickRetainedNotification(electronApp)
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId))
    .toBe(targetWorkspace)
  await orcaPage.waitForTimeout(1200)
  const remainingTabs = await orcaPage.evaluate(
    (worktreeId) =>
      (window.__store!.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
    targetWorkspace
  )
  if (baseline) {
    expect(remainingTabs.length).toBeGreaterThan(0)
  } else {
    expect(remainingTabs).toEqual([])
  }
  expect(remainingTabs).not.toContain(originTabId)
  await orcaPage.screenshot({ path: testInfo.outputPath('closed-after-click.png') })
  await testInfo.attach('closed session after click', {
    path: testInfo.outputPath('closed-after-click.png'),
    contentType: 'image/png'
  })
  await orcaPage.waitForTimeout(1200)
})
