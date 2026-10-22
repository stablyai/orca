import { expect, test } from './helpers/orca-app'
import {
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'
import {
  deferTranscriptResponse,
  releaseTranscriptResponse,
  seedTranscriptPalette,
  transcriptHits
} from './helpers/cmd-j-transcript-fixture'

test.use({ minimumSeededWorktreeCount: 1 })

test('Cmd+J keeps remaining results selectable after the selected row closes', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  await deferTranscriptResponse(electronApp)
  await seedTranscriptPalette(orcaPage)
  const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
  const input = palette.locator('[cmdk-input]')
  await input.fill('refresh')
  await expect(palette.locator('[cmdk-item][data-value*="workspace-tab"]')).toHaveCount(50)
  await input.press('ArrowDown')
  await input.press('ArrowDown')
  const selected = palette.locator('[cmdk-item][data-selected="true"]')
  const current = await selected.getAttribute('data-value')
  const tabId = current?.match(/transcript-fixture-\d+$/u)?.[0]
  expect(tabId).toBeTruthy()
  await orcaPage.evaluate((tabId) => {
    const store = window.__store!
    const state = store.getState()
    store.setState({
      unifiedTabsByWorktree: Object.fromEntries(
        Object.entries(state.unifiedTabsByWorktree).map(([key, tabs]) => [
          key,
          tabs.filter((tab) => tab.entityId !== tabId)
        ])
      ),
      tabsByWorktree: Object.fromEntries(
        Object.entries(state.tabsByWorktree).map(([key, tabs]) => [
          key,
          tabs.filter((tab) => tab.id !== tabId)
        ])
      )
    })
  }, tabId)
  await expect(palette.locator(`[cmdk-item][data-value$="${tabId}"]`)).toHaveCount(0)
  // Accept cmdk's upstream reset without carrying a dependency patch.
  const rows = palette.locator('[cmdk-item]')
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await input.press('ArrowDown')
  await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true')
})

for (const gesture of ['ArrowDown', 'Control+n', 'Control+j', 'hover', 'scroll'] as const) {
  test(`Cmd+J preserves observed rectangles and pointer targets after ${gesture} while late hits enter a full cap`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await waitForStartupWorktreeRefresh(orcaPage)
    await deferTranscriptResponse(electronApp)
    await seedTranscriptPalette(orcaPage)
    const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    const input = palette.locator('[cmdk-input]')
    await input.fill('refresh')
    const rows = palette.locator('[cmdk-item][data-value*="workspace-tab"]')
    await expect(rows).toHaveCount(50)
    const excerpts = rows.locator('[data-slot="palette-open-tab-transcript-snippet"]')
    await expect(excerpts).toHaveCount(50)
    await expect(excerpts.first()).toBeEmpty()
    const keyboardGesture = gesture !== 'hover' && gesture !== 'scroll'
    if (keyboardGesture) {
      await input.press(gesture)
    }
    if (gesture === 'scroll') {
      await palette.locator('[cmdk-list]').hover()
      await orcaPage.mouse.wheel(0, 150)
    }
    const target = keyboardGesture
      ? palette.locator('[cmdk-item][data-selected="true"]')
      : rows.nth(gesture === 'scroll' ? 4 : 1)
    if (gesture === 'hover') {
      await target.hover()
    }
    const before = await target.evaluate((target) => {
      const rect = target.getBoundingClientRect()
      const list = target.closest('[cmdk-list]')
      return {
        value: target.getAttribute('data-value'),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scrollTop: list?.scrollTop,
        viewportHeight: list?.getBoundingClientRect().height,
        pointerX: rect.x + rect.width / 2,
        pointerY: rect.y + rect.height / 2
      }
    })
    const selectedBefore = await palette
      .locator('[cmdk-item][data-selected="true"]')
      .getAttribute('data-value')
    await releaseTranscriptResponse(electronApp)
    await expect(palette.getByText('Useful conversation 0', { exact: true })).toBeVisible()
    await expect(rows).toHaveCount(50)
    const after = await orcaPage.evaluate(({ value, pointerX, pointerY }) => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]')).find(
        (node) => node.dataset.value === value
      )
      if (!target) {
        throw new Error('Observed target disappeared')
      }
      const rect = target.getBoundingClientRect()
      const list = target.closest('[cmdk-list]')
      return {
        value: target.dataset.value,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scrollTop: list?.scrollTop,
        viewportHeight: list?.getBoundingClientRect().height,
        hit: document
          .elementFromPoint(pointerX, pointerY)
          ?.closest('[cmdk-item]')
          ?.getAttribute('data-value')
      }
    }, before)
    const { pointerX: _pointerX, pointerY: _pointerY, ...rectangleBefore } = before
    expect(after).toEqual({ ...rectangleBefore, hit: before.value })
    await expect(palette.locator('[cmdk-item][data-selected="true"]')).toHaveAttribute(
      'data-value',
      selectedBefore ?? ''
    )
    await expect(palette.getByText('20 more', { exact: true })).toBeVisible()
    await palette.screenshot({
      path: testInfo.outputPath(`transcript-${gesture}.png`),
      animations: 'disabled'
    })
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    const activatedTabId = selectedBefore?.match(/transcript-fixture-\d+$/u)?.[0]
    expect(activatedTabId).toBeTruthy()
    await expect(
      orcaPage.locator(`[data-tab-id="${activatedTabId}"][data-active="true"]`)
    ).toBeVisible()
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  })
}

test('Cmd+J commits strong transcript order and default selection together before interaction', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  await deferTranscriptResponse(electronApp, transcriptHits(50, undefined, 100))
  await seedTranscriptPalette(orcaPage, 50, 'refresh', 100)
  await orcaPage.evaluate(() => {
    const store = window.__store!
    store.setState({
      worktreesByRepo: Object.fromEntries(
        Object.entries(store.getState().worktreesByRepo).map(([repoId, worktrees]) => [
          repoId,
          worktrees.map((worktree) => ({ ...worktree, displayName: 'Unrelated workspace' }))
        ])
      )
    })
  })
  const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
  await palette.locator('[cmdk-input]').fill('refresh')
  await expect(palette.locator('[cmdk-item][data-value*="workspace-tab"]')).toHaveCount(50)
  await expect(palette.locator('[cmdk-item]').first()).toContainText('refresg')
  await releaseTranscriptResponse(electronApp)
  const first = palette.locator('[cmdk-item]').first()
  await expect(first).toContainText('Useful conversation 0')
  await expect(first).toHaveAttribute('data-selected', 'true')
  await expect(
    palette
      .locator('[cmdk-item][data-value*="workspace-tab"]')
      .filter({ hasText: 'Useful conversation' })
  ).toHaveCount(50)
  const widths = await palette
    .locator('[data-slot="palette-open-tab-transcript-snippet"]')
    .evaluateAll((lines) =>
      lines.map((line) => {
        const rectangle = line.getBoundingClientRect()
        return {
          width: rectangle.width,
          clientWidth: line.clientWidth,
          fits: line.scrollWidth <= line.clientWidth
        }
      })
    )
  expect(new Set(widths.map((line) => line.width)).size).toBe(1)
  const measuredWidth = await palette
    .locator('[data-slot="palette-transcript-ruler"]')
    .evaluate((ruler) => ruler.clientWidth)
  expect([...new Set(widths.map((line) => line.clientWidth))]).toEqual([measuredWidth])
  expect(widths.every((line) => line.fits)).toBe(true)
  await palette.screenshot({
    path: testInfo.outputPath('transcript-before-interaction.png'),
    animations: 'disabled'
  })
})

test('Cmd+J requires actual highlighted fit and recomputes after an explicit resize', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  await orcaPage.setViewportSize({ width: 420, height: 800 })
  const query = 'authentication synchronisation configuration infrastructure'
  await deferTranscriptResponse(electronApp, transcriptHits(6, `We fixed ${query} here.`))
  await seedTranscriptPalette(orcaPage, 6, query)
  const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
  await palette.locator('[cmdk-input]').fill(query)
  await releaseTranscriptResponse(electronApp)
  await expect(palette.getByText('Useful conversation 0', { exact: true })).toBeVisible()
  const first = palette.locator('[cmdk-item]').first()
  await expect(first).toContainText('preauthenticationpost')
  await orcaPage.setViewportSize({ width: 1200, height: 900 })
  await expect(first).toContainText('Useful conversation 0')
  await expect(first.locator('[data-slot="palette-open-tab-transcript-snippet"]')).toContainText(
    query
  )
})

test('Cmd+J budgets density and renderer work at the 100-candidate bound', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  const hits = transcriptHits(100, '', 100).map((hit, index) => ({
    ...hit,
    evidence: {
      role: 'assistant' as const,
      timestamp: null,
      snippet: 'a [[refresh]] …',
      originalExcerpt: {
        text: `Case ${index}: a refresh issue here ${'context '.repeat(12)}and refresh again ${'context '.repeat(12)}then refresh here ${'context '.repeat(12)}with refresh here. `.slice(
          0,
          512
        )
      }
    }
  }))
  await deferTranscriptResponse(electronApp, hits)
  await seedTranscriptPalette(orcaPage, 100, 'refresh', 100)
  const palette = orcaPage.locator('[role="dialog"]')
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const settings = store.getState().settings
    if (!settings) {
      throw new Error('Missing hydrated settings')
    }
    store.setState({
      settings: {
        ...settings,
        aiVaultSearch: { enabled: false, historyDays: null }
      }
    })
  })
  const session = await orcaPage.context().newCDPSession(orcaPage)
  await session.send('Performance.enable', { timeDomain: 'threadTicks' })
  await orcaPage.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const baselineStart = await session.send('Performance.getMetrics')
  await session.send('Runtime.evaluate', {
    expression: `new Promise(resolve => {
      const observer = new MutationObserver(check);
      function check() {
        const rows = document.querySelectorAll('[role="dialog"] [cmdk-item][data-value*="workspace-tab"]');
        if (rows.length === 50 && rows[0]?.textContent?.includes('refresg')) {
          observer.disconnect();
          void rows[0].getBoundingClientRect();
          resolve(true);
        }
      }
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      const input = document.querySelector('[cmdk-input]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter.call(input, 'refresh');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      check();
    })`,
    awaitPromise: true,
    returnByValue: true
  })
  const baselineEnd = await session.send('Performance.getMetrics')
  const visibleCount = async () =>
    palette.locator('[cmdk-item]').evaluateAll((rows) => {
      const viewport = document.querySelector('[cmdk-list]')?.getBoundingClientRect()
      return viewport
        ? rows.filter((row) => {
            const rect = row.getBoundingClientRect()
            return rect.bottom > viewport.top && rect.top < viewport.bottom
          }).length
        : 0
    })
  const baselineVisible = await visibleCount()
  await orcaPage.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    if (!original?.get) {
      throw new Error('Missing layout getter')
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        const start = performance.now()
        const width = original.get?.call(this)
        if (
          this instanceof HTMLElement &&
          this.firstElementChild?.getAttribute('data-slot') ===
            'palette-transcript-measurement-text'
        ) {
          performance.measure('cmd-j-transcript-fit', { start, end: performance.now() })
        }
        return width
      }
    })
    const store = window.__store!
    const settings = store.getState().settings
    if (!settings) {
      throw new Error('Missing hydrated settings')
    }
    store.setState({
      settings: {
        ...settings,
        aiVaultSearch: { enabled: true, historyDays: null }
      }
    })
  })
  await expect(
    palette.locator('[cmdk-item] [data-slot="palette-open-tab-transcript-snippet"]')
  ).toHaveCount(50)
  const proposedVisible = await visibleCount()
  await releaseTranscriptResponse(electronApp, 500)
  const waiting = await session.send('Runtime.evaluate', {
    expression: `!document.querySelector('[role="dialog"] [cmdk-item]')?.textContent?.includes('Useful conversation 0')`,
    returnByValue: true
  })
  expect(waiting.result.value).toBe(true)
  const arrivalStart = await session.send('Performance.getMetrics')
  const committed = session.send('Runtime.evaluate', {
    expression: `new Promise(resolve => {
      const observer = new MutationObserver(check);
      function check() {
        const row = document.querySelector('[role="dialog"] [cmdk-item]');
        if (row?.textContent?.includes('Useful conversation 0')) {
          observer.disconnect();
          void row.getBoundingClientRect();
          resolve(true);
        }
      }
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      check();
    })`,
    awaitPromise: true,
    returnByValue: true
  })
  await committed
  const arrivalEnd = await session.send('Performance.getMetrics')
  const fits = await orcaPage.evaluate(() =>
    performance.getEntriesByName('cmd-j-transcript-fit').map((entry) => entry.duration)
  )
  const taskMs = (metrics: { metrics: { name: string; value: number }[] }): number =>
    (metrics.metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0) * 1000
  const report = {
    baselineVisible,
    proposedVisible,
    rowsLost: baselineVisible - proposedVisible,
    baselineRendererTaskMs: taskMs(baselineEnd) - taskMs(baselineStart),
    arrivalRendererTaskMs: taskMs(arrivalEnd) - taskMs(arrivalStart),
    measurementCount: fits.length,
    measurementMs: fits.reduce((sum, value) => sum + value, 0)
  }
  console.log('Cmd+J renderer budget', JSON.stringify(report))
  await testInfo.attach('transcript-renderer-budget', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
  expect(report.rowsLost).toBeLessThanOrEqual(4)
  expect(report.measurementCount).toBeGreaterThan(0)
  expect(report.measurementCount).toBeLessThanOrEqual(100)
  // Timing gates belong to isolated reference runs; work and density bounds apply everywhere.
  if (process.env.ORCA_CMD_J_EVALUATION === '1') {
    expect(report.arrivalRendererTaskMs).toBeLessThanOrEqual(100)
    expect(report.measurementMs).toBeLessThanOrEqual(16)
  }
})
