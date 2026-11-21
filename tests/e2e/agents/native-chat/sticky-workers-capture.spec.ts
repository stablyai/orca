import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyStickyInput } from './sticky-workers-input.test-fixture'
import { measureStickyPerformance } from './sticky-workers-performance.test-fixture'
import { homedir } from 'node:os'
import { test, openStubChat } from '../session-fixtures/structured-claude-stub'
import '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  measureStickyLayout,
  verifyQuestionKeyboardReachability
} from './sticky-workers-layout.test-fixture'

declare global {
  var __stickyWorkersHarness:
    | {
        seed: (
          session: string,
          count: number,
          asks: boolean,
          options: { failures?: number; remote?: boolean }
        ) => void
        fail: (session: string) => string
      }
    | undefined
}

const root = join(homedir(), '.orca/reports/sticky-workers/impl')
const phase = process.env.STICKY_CAPTURE_PHASE ?? 'baseline'
test.use({ minimumSeededWorktreeCount: 1, orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('captures the worker strip in an isolated hidden native chat', async ({
  orcaPage: page,
  electronApp,
  claudeStub
}) => {
  // Ten viewport/theme captures include a complete 20-question keyboard pass in each.
  test.setTimeout(300_000)
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
  if (scenario !== 'providers' && scenario !== 'running') {
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
    await page.evaluate(
      (session) =>
        window.api.runtime.call({
          method: 'orchestration.workerDockRead',
          params: { party: `orca_session_id:${session}` }
        }),
      sessionId
    )
    await electronApp.evaluate(
      (_electron, data) => {
        const harness = globalThis.__stickyWorkersHarness
        if (!harness) {
          throw new Error(
            'The current capture build must include the documented host harness instrumentation.'
          )
        }
        harness.seed(data.sessionId, data.count, data.scenario === 'asks-20', {
          failures: data.scenario === 'failures' ? Math.max(2, data.count) : undefined,
          remote: data.scenario === 'remote'
        })
      },
      { sessionId, count, scenario }
    )
    seeded = { sessionId, database }
    await page.locator('[data-testid="sortable-tab"]').filter({ hasText: 'Terminal 1' }).click()
    await chat.tab.click()
  }
  await chat.composer.fill(
    scenario === 'mixed'
      ? 'sticky-mixed:2'
      : scenario === 'providers' || scenario === 'running'
        ? `sticky-roster:${count}`
        : 'Show the synthetic worker roster'
  )
  await chat.send.click()
  // Large rosters persist every task_started frame before the stub turn can finish.
  await expect(page.getByText('Stub reply.', { exact: true }).last()).toBeVisible({
    timeout: 60_000
  })
  const strip = page.locator('[data-native-chat-background-tasks="true"]')
  if (count > 0) {
    await expect(strip).toBeVisible({ timeout: 30_000 })
    if (scenario !== 'asks-20') {
      await strip.getByRole('button', { expanded: false }).click()
      await expect(strip.getByRole('region', { name: /^Workers/ })).toBeVisible()
    }
  }
  if (scenario === 'running') {
    // ast-grep-ignore: test-no-real-time-wait -- Capture an actual observed running age, without a mocked clock.
    await page.waitForTimeout(65_000)
  }
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
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
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
      if (scenario === 'workers' && count >= 20) {
        const region = strip.getByRole('region', { name: /^Workers/ })
        await region.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        measurements.push({
          theme,
          width,
          height,
          edge: 'end',
          layout: await measureStickyLayout(page, 0)
        })
        await page.screenshot({
          path: join(root, 'shots', `${phase}-${scene}-scroll-end-${theme}-${width}x${height}.png`)
        })
        await region.evaluate((element) => {
          element.scrollTop = 0
        })
        await measureStickyLayout(page, 0)
      }
      const stopTarget = page.locator('[data-worker-dock-action][aria-label^="Stop "]').first()
      if (await stopTarget.count()) {
        await stopTarget.hover()
        await expect(stopTarget).toBeVisible()
        await page.screenshot({
          path: join(root, 'shots', `${phase}-${scene}-stop-hover-${theme}-${width}x${height}.png`)
        })
        await stopTarget.focus()
        await expect(stopTarget).toBeFocused()
        await page.keyboard.press('Escape')
      }
      if (scenario === 'remote' && width === 900) {
        const remoteStop = strip.getByRole('button', { name: /^Stop ORCA-1 ·/ })
        await chat.composer.focus()
        await page.mouse.move(5, 5)
        await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
        await remoteStop.focus()
        const policy = page.getByRole('tooltip', { name: /computer it runs on/ })
        await expect(policy).toBeVisible()
        measurements.push({
          theme,
          width,
          height,
          remote: {
            action: await remoteStop.getAttribute('aria-label'),
            unavailable: await remoteStop.getAttribute('aria-disabled'),
            policy: await policy.textContent()
          }
        })
        await page.screenshot({
          path: join(
            root,
            'shots',
            `${phase}-${scene}-owner-policy-${theme}-${width}x${height}.png`
          )
        })
        await page.keyboard.press('Escape')
      }
      if (scenario === 'asks-20') {
        const order = () =>
          page
            .locator('[data-native-chat-worker-question-summary]')
            .evaluateAll((rows) =>
              rows.map((row) => row.getAttribute('data-native-chat-worker-question-summary'))
            )
        const before = await order()
        const expandedAsk = page.locator('[data-native-chat-worker-approval]')
        const shown = (await expandedAsk.count())
          ? await expandedAsk.getAttribute('data-native-chat-worker-approval')
          : null
        if (count === 20) {
          expect(shown ?? before[0]).toBe('apr_sticky_19')
        }
        const keyboard = await verifyQuestionKeyboardReachability(
          page,
          await page.getByRole('button', { name: /^Show .* question$/ }).count()
        )
        const after = await order()
        expect(after).toEqual(before)
        measurements.push({
          theme,
          width,
          height,
          shown,
          orderBefore: before,
          orderAfter: after,
          keyboard
        })
        await page.screenshot({
          path: join(root, 'shots', `${phase}-${scene}-focused-${theme}-${width}x${height}.png`)
        })
        if (height < 520) {
          await page
            .getByRole('button', { name: /^Show .* question$/ })
            .first()
            .click()
          await expect(page.getByRole('dialog')).toBeVisible()
          await page.screenshot({
            path: join(
              root,
              'shots',
              `${phase}-${scene}-newest-ask-dialog-${theme}-${width}x${height}.png`
            )
          })
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
        }
      }
    }
  }
  await page.setViewportSize({ width: 900, height: 720 })
  await expect(page.getByText('Stub reply.', { exact: true }).last()).toBeVisible()
  const source = seeded
  const input =
    process.env.STICKY_CAPTURE_PERF !== '1' && scenario === 'workers' && count >= 8 && source
      ? await verifyStickyInput(page, chat.composer, source.database, source.sessionId, () =>
          electronApp.evaluate((_electron, session) => {
            const harness = globalThis.__stickyWorkersHarness
            if (!harness) {
              throw new Error('The capture host adapter is missing.')
            }
            return harness.fail(session)
          }, source.sessionId)
        )
      : null
  const performanceResults =
    process.env.STICKY_CAPTURE_PERF === '1'
      ? await measureStickyPerformance(
          page,
          chat.composer,
          join(root, 'perf', `${phase}-${scene}-renderer-trace.json`)
        )
      : null
  let hidden: unknown = null
  if (process.env.STICKY_CAPTURE_PERF === '1') {
    await page.locator('[data-testid="sortable-tab"]').filter({ hasText: 'Terminal 1' }).click()
    await expect(chat.composer).not.toBeVisible()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await page.evaluate(() => {
      for (const mark of ['chat', 'composer', 'strip']) {
        performance.clearMarks(`sticky-workers:${mark}:render`)
      }
    })
    await electronApp.evaluate(() => {
      const harness = globalThis.__stickyWorkersHarness
      if (!harness) {
        throw new Error('The capture host adapter is missing.')
      }
      harness.seed('22222222-2222-4222-8222-222222222222', 1, false, {})
    })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    hidden = await page.evaluate(() =>
      Object.fromEntries(
        ['chat', 'composer', 'strip'].map((mark) => [
          mark,
          performance.getEntriesByName(`sticky-workers:${mark}:render`).length
        ])
      )
    )
    expect(hidden).toEqual({ chat: 0, composer: 0, strip: 0 })
  }
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
        input,
        hidden
      },
      null,
      2
    )
  )
})
