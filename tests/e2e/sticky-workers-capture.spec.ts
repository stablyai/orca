import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyStickyInput } from './sticky-workers-input.test-fixture'
import { measureStickyPerformance } from './sticky-workers-performance.test-fixture'
import { seedStickyWorkers } from './sticky-workers-roster.test-fixture'
import { homedir } from 'node:os'
import { test, openStubChat } from './helpers/structured-claude-stub'
import { expect } from './helpers/orca-app'
import {
  measureStickyLayout,
  verifyQuestionKeyboardReachability
} from './sticky-workers-layout.test-fixture'

const root = join(homedir(), '.orca/reports/sticky-workers/impl')
const phase = process.env.STICKY_CAPTURE_PHASE ?? 'baseline'
test.use({ minimumSeededWorktreeCount: 1, orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('captures the worker strip in an isolated hidden native chat', async ({
  orcaPage: page,
  electronApp,
  claudeStub
}) => {
  // Ten viewport/theme captures include a complete 20-question keyboard pass in each.
  test.setTimeout(180_000)
  const identity = await electronApp.evaluate(({ app, BrowserWindow }) => ({
    appPath: app.getAppPath(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(identity.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  if (process.platform === 'darwin') {
    await page.evaluate(() => window.api.macosTccPrompts.dismiss())
    const nudge = page.getByRole('button', { name: "Don't show again", exact: true })
    if (await nudge.count()) {
      await nudge.click()
    }
  }
  const chat = await openStubChat(page, claudeStub.command)
  await page.evaluate(() => {
    void window.api.starNag.disable()
    const state = window.__store?.getState()
    if (state?.sidebarOpen) {
      state.toggleSidebar()
    }
    state?.setRightSidebarOpen(false)
  })
  const scenario = process.env.STICKY_CAPTURE_SCENE ?? 'providers'
  const count = Number(process.env.STICKY_CAPTURE_COUNT ?? 20)
  const scene = `${scenario}-${count}`
  let seeded: { sessionId: string; database: string } | null = null
  if (scenario !== 'providers') {
    const sessionId = await page.evaluate(
      () =>
        Object.values(window.__store?.getState().unifiedTabsByWorktree ?? {})
          .flat()
          .find((tab) => tab.contentType === 'agent-session')?.entityId
    )
    const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    if (!sessionId) {
      throw new Error('No capture source session.')
    }
    const database = join(profile, 'orchestration.db')
    seedStickyWorkers(database, sessionId, count, scenario === 'asks-20')
    seeded = { sessionId, database }
    await page.locator('[data-testid="sortable-tab"]').filter({ hasText: 'Terminal 1' }).click()
    await chat.tab.click()
  }
  await chat.composer.fill(
    scenario === 'mixed'
      ? 'sticky-mixed:2'
      : scenario === 'providers'
        ? `sticky-roster:${count}`
        : 'Show the synthetic worker roster'
  )
  await chat.send.click()
  // Large rosters persist every task_started frame before the stub turn can finish.
  await expect(page.getByText('Stub reply.', { exact: true }).last()).toBeVisible({
    timeout: 60_000
  })
  const strip = page.locator('[data-native-chat-background-tasks="true"]')
  await expect(strip).toBeVisible({ timeout: 30_000 })
  const disclosure = strip.getByRole('button', { expanded: false })
  await disclosure.click()
  await expect(strip.getByRole('region', { name: /^Workers/ })).toBeVisible()
  mkdirSync(join(root, 'shots'), { recursive: true })
  const measurements: unknown[] = []
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async (theme) => {
      await window.__store?.getState().updateSettings({ theme })
    }, theme)
    for (const [width, height] of [
      [900, 720],
      [390, 720],
      [320, 640],
      [390, 430],
      [320, 430]
    ]) {
      await page.setViewportSize({ width, height })
      await chat.composer.focus()
      await page.mouse.move(5, 5)
      await page.evaluate(() => {
        for (const element of document.querySelectorAll(
          '[data-native-chat-worker-dock], [data-native-chat-background-tasks] [role="region"], [aria-label="Queued worker questions"]'
        )) {
          element.scrollTop = 0
        }
      })
      measurements.push(await measureStickyLayout(page, scenario === 'asks-20' ? count : 0))
      await page.screenshot({
        path: join(root, 'shots', `${phase}-${scene}-native-${theme}-${width}x${height}.png`)
      })
      const stopTarget = page.locator('[data-worker-dock-action][aria-label^="Stop "]').first()
      if (await stopTarget.count()) {
        await stopTarget.focus()
        await expect(stopTarget).toBeFocused()
      }
      if (scenario === 'asks-20') {
        measurements.push({
          theme,
          width,
          height,
          keyboard: await verifyQuestionKeyboardReachability(page, count)
        })
        await page.screenshot({
          path: join(root, 'shots', `${phase}-${scene}-focused-${theme}-${width}x${height}.png`)
        })
      }
    }
  }
  await page.setViewportSize({ width: 900, height: 720 })
  await expect(page.getByText('Stub reply.', { exact: true }).last()).toBeVisible()
  const input =
    scenario === 'workers' && count >= 8 && seeded
      ? await verifyStickyInput(page, chat.composer, seeded.database, seeded.sessionId)
      : null
  const performanceResults =
    process.env.STICKY_CAPTURE_PERF === '1'
      ? await measureStickyPerformance(
          page,
          chat.composer,
          join(root, 'perf', `${phase}-${scene}-renderer-trace.json`)
        )
      : null
  writeFileSync(
    join(root, `${phase}-${scene}-native.json`),
    JSON.stringify(
      {
        phase,
        identity,
        method:
          'repository Electron Playwright harness, isolated profile, ORCA_BACKGROUND_LAUNCH=1, hidden renderer CDP screenshot',
        data: {
          scenario,
          count,
          source:
            'synthetic lifecycle facts and/or task_started frames via existing fake Claude, actual app host and renderer'
        },
        measurements,
        performance: performanceResults,
        input
      },
      null,
      2
    )
  )
})
