import { expect, type Page } from '@playwright/test'

/** Chromium focus and hit testing only; native OS focus, IME and screen readers need isolation. */
export async function measureStickyLayout(page: Page, askCount: number) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const readLayout = () =>
    page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('[data-native-chat-worker-dock]')
      const pane = document.querySelector<HTMLElement>('[data-native-chat-root]')
      const queue = document.querySelector<HTMLElement>('[aria-label="Queued worker questions"]')
      const rect = (element: Element | null | undefined) =>
        element?.getBoundingClientRect().toJSON()
      const frameRect = frame?.getBoundingClientRect()
      const header = document.querySelector('[data-worker-dock-header]')?.getBoundingClientRect()
      const workerRows = [...document.querySelectorAll<HTMLElement>('[data-worker-dock-row]')].map(
        (row) => {
          const bounds = row.getBoundingClientRect()
          const region = row.closest('[role="region"]')!.getBoundingClientRect()
          const top = Math.max(frameRect?.top ?? 0, header?.bottom ?? 0, region.top)
          const bottom = Math.min(frameRect?.bottom ?? 0, region.bottom)
          return {
            id: row.dataset.workerDockRow,
            bounds: bounds.toJSON(),
            top,
            bottom,
            intersects: bounds.bottom > top + 1 && bounds.top < bottom - 1,
            complete: bounds.top >= top - 1 && bounds.bottom <= bottom + 1
          }
        }
      )
      const floating = document
        .querySelector('[data-floating-terminal-toggle]')
        ?.getBoundingClientRect()
      const send = document
        .querySelector('[data-composer-primary-icon]')
        ?.closest('button')
        ?.getBoundingClientRect()
      const sendCovered = Boolean(
        floating &&
        send &&
        floating.left < send.right &&
        floating.right > send.left &&
        floating.top < send.bottom &&
        floating.bottom > send.top
      )
      const scrollers = [...(frame?.querySelectorAll<HTMLElement>('*') ?? [])]
        .filter(
          (node) =>
            /auto|scroll/.test(getComputedStyle(node).overflowY) &&
            node.scrollHeight > node.clientHeight + 1
        )
        .map((node) => ({
          tag: node.tagName,
          role: node.getAttribute('role'),
          label: node.getAttribute('aria-label'),
          bounds: rect(node)
        }))
      const frameBorder = frame ? Number.parseFloat(getComputedStyle(frame).borderBottomWidth) : 0
      const queueRect = queue?.getBoundingClientRect()
      const top = Math.max(frameRect?.top ?? 0, queueRect?.top ?? 0)
      const bottom = Math.min((frameRect?.bottom ?? 0) - frameBorder, queueRect?.bottom ?? 0)
      const rows = [
        ...document.querySelectorAll<HTMLElement>('[data-native-chat-worker-question-summary]')
      ].map((row) => {
        const button = row.querySelector('button')!
        const bounds = button.getBoundingClientRect()
        const hit = [
          [bounds.left + bounds.width / 2, bounds.top + 1],
          [bounds.left + bounds.width / 2, bounds.bottom - 1],
          [bounds.left + 1, bounds.top + bounds.height / 2],
          [bounds.right - 1, bounds.top + bounds.height / 2]
        ].every(([x, y]) => button.contains(document.elementFromPoint(x, y)))
        return {
          id: row.dataset.nativeChatWorkerQuestionSummary,
          button: rect(button),
          hit,
          intersectsFrame: bounds.top < bottom && bounds.bottom > top,
          completeInFrame: bounds.top >= top && bounds.bottom <= bottom
        }
      })
      const reasons = [...document.querySelectorAll<HTMLElement>('[data-worker-dock-reason]')].map(
        (reason) => {
          const state = reason.previousElementSibling!.getBoundingClientRect()
          const bounds = reason.getBoundingClientRect()
          const text = reason.firstChild!
          const range = document.createRange()
          range.setStart(text, Math.max(0, (text.textContent?.length ?? 0) - 2))
          range.setEnd(text, text.textContent?.length ?? 0)
          return {
            gap: bounds.top - state.bottom,
            bounds: bounds.toJSON(),
            ending: range.getBoundingClientRect().toJSON()
          }
        }
      )
      return {
        expandedQuestion: Boolean(document.querySelector('[data-native-chat-worker-approval]')),
        expanded: Boolean(
          document.querySelector('[data-native-chat-background-tasks] [aria-expanded="true"]')
        ),
        workerRows,
        sendCovered,
        scrollers,
        header: header?.toJSON(),
        reasons,
        viewport: [innerWidth, innerHeight],
        frame: rect(frame),
        pane: rect(pane),
        queue: rect(queue),
        rows,
        composer: rect(document.querySelector('[data-composer-field]'))
      }
    })
  await expect
    .poll(async () => {
      const layout = await readLayout()
      return {
        questions: askCount
          ? layout.rows.filter((row) => row.intersectsFrame && !row.completeInFrame)
          : [],
        workers: layout.workerRows.filter((row) => row.intersects && !row.complete),
        visible:
          !layout.expanded ||
          !layout.workerRows.length ||
          layout.workerRows.some((row) => row.intersects)
      }
    })
    .toEqual({ questions: [], workers: [], visible: true })
  const layout = await readLayout()
  expect(layout.sendCovered).toBe(false)
  if (layout.expanded && layout.workerRows.length) {
    expect(layout.workerRows.some((row) => row.intersects)).toBe(true)
  }
  expect(
    layout.workerRows.filter((row) => row.intersects && !row.complete),
    JSON.stringify(layout.workerRows)
  ).toEqual([])
  if (layout.viewport[0] === 320) {
    for (const reason of layout.reasons) {
      expect(reason.gap).toBeLessThanOrEqual(1)
      expect(reason.ending.bottom).toBeLessThanOrEqual(reason.bounds.bottom + 1)
      expect(reason.ending.right).toBeLessThanOrEqual(reason.bounds.right + 1)
    }
  }
  if (layout.frame && layout.pane) {
    expect(layout.frame.height).toBeLessThanOrEqual(layout.pane.height * 0.4 + 1)
  }
  if (askCount) {
    await expect(page.getByRole('button', { name: /^Show .* question$/ })).toHaveCount(
      askCount - (layout.expandedQuestion ? 1 : 0)
    )
    // The viewport's settled boundary must not cut a target in half.
    expect(
      layout.rows.filter((row) => row.intersectsFrame && !row.completeInFrame),
      JSON.stringify(layout)
    ).toEqual([])
    for (const row of layout.rows.filter((row) => row.intersectsFrame)) {
      expect(row.hit, JSON.stringify(row)).toBe(true)
    }
  }
  const stop = page.locator('[data-worker-dock-action][aria-label^="Stop "]').first()
  if (await stop.count()) {
    const size = await stop.boundingBox()
    expect(size?.width).toBeGreaterThanOrEqual(page.viewportSize()!.width < 700 ? 44 : 26)
    expect(size?.height).toBeGreaterThanOrEqual(page.viewportSize()!.width < 700 ? 44 : 26)
  }
  return layout
}

export async function verifyQuestionKeyboardReachability(page: Page, count: number) {
  const buttons = page.getByRole('button', { name: /^Show .* question$/ })
  await buttons.first().focus()
  const reached: unknown[] = []
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect(button).toBeFocused()
    const geometry = await button.evaluate((element) => {
      const target = element.getBoundingClientRect()
      const frame = element.closest('[data-native-chat-worker-dock]')!.getBoundingClientRect()
      const queue = element
        .closest('[aria-label="Queued worker questions"]')!
        .getBoundingClientRect()
      const points = [
        [target.left + target.width / 2, target.top + 1],
        [target.left + target.width / 2, target.bottom - 1],
        [target.left + 1, target.top + target.height / 2],
        [target.right - 1, target.top + target.height / 2]
      ]
      const hits = points.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return { x, y, inside: element.contains(hit), element: hit?.outerHTML.slice(0, 200) }
      })
      const hit = hits.every((point) => point.inside)
      return {
        label: element.getAttribute('aria-label'),
        target: target.toJSON(),
        frame: frame.toJSON(),
        queue: queue.toJSON(),
        hits,
        hit
      }
    })
    expect(geometry.target.width).toBeGreaterThanOrEqual(44)
    expect(geometry.target.height).toBeGreaterThanOrEqual(44)
    expect(geometry.target.top).toBeGreaterThanOrEqual(
      Math.max(geometry.frame.top, geometry.queue.top) - 1
    )
    expect(geometry.target.bottom).toBeLessThanOrEqual(
      Math.min(geometry.frame.bottom, geometry.queue.bottom) + 1
    )
    expect(geometry.hit, JSON.stringify(geometry)).toBe(true)
    reached.push(geometry)
    if (index + 1 < count) {
      await page.keyboard.press('Tab')
    }
  }
  return reached
}
