/**
 * The desktop sidebar drawn from main's feed (ORCA_SIDEBAR_INPUTS=main): it follows main, not the
 * window's own store, and a drag, create, open or collapse still lands in the frame it is made.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { removeWorktreeViaStore } from './helpers/dead-terminal'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.skip(!SIDEBAR_INPUTS_BUILD, 'the window reads main only in an ORCA_SIDEBAR_INPUTS=main build')

const ROWS = '[data-worktree-sidebar] [role="option"][data-worktree-id]'

function renderedOrder(page: Page): Promise<string[]> {
  return page.locator(ROWS).evaluateAll((elements) =>
    elements
      .map((element) => ({
        id: element.getAttribute('data-worktree-id') ?? '',
        top: element.getBoundingClientRect().top
      }))
      .sort((left, right) => left.top - right.top)
      .map((entry) => entry.id)
  )
}

/** `sinceInput`: ms since the first pointerup or click after the log started. */
type Frame = { ids: string[]; shows: boolean; sinceInput: number | null }

type FrameLog = { stop: () => Promise<Frame[]> }

/** Records, every animation frame, the rendered row ids and whether the sidebar shows `text`. */
async function startFrameLog(page: Page, text = ''): Promise<FrameLog> {
  const handle = await page.evaluateHandle(
    ({ selector, wanted }) => {
      const frames: Frame[] = []
      let running = true
      let inputAt: number | null = null
      const onInput = (): void => {
        inputAt ??= performance.now()
      }
      window.addEventListener('pointerup', onInput, true)
      window.addEventListener('mouseup', onInput, true)
      window.addEventListener('click', onInput, true)
      const sample = (): void => {
        if (!running) {
          return
        }
        const sidebar = document.querySelector('[data-worktree-sidebar]')
        frames.push({
          ids: [...document.querySelectorAll<HTMLElement>(selector)]
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
            .map((row) => row.dataset.worktreeId ?? ''),
          shows: wanted !== '' && (sidebar?.textContent ?? '').includes(wanted),
          sinceInput: inputAt === null ? null : performance.now() - inputAt
        })
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      return () => {
        running = false
        window.removeEventListener('pointerup', onInput, true)
        window.removeEventListener('mouseup', onInput, true)
        window.removeEventListener('click', onInput, true)
        return frames
      }
    },
    { selector: ROWS, wanted: text }
  )
  return { stop: () => handle.evaluate((stop) => stop()) }
}

async function dragBefore(page: Page, sourceId: string, targetId: string): Promise<void> {
  const source = page.locator(`${ROWS}[data-worktree-id=${JSON.stringify(sourceId)}]`).first()
  const target = page.locator(`${ROWS}[data-worktree-id=${JSON.stringify(targetId)}]`).first()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('drag geometry unavailable')
  }
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 3, { steps: 8 })
  await page.mouse.up()
}

test('the sidebar lists main’s inputs and keeps drag, create, open and collapse instant', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const created = await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    state.setGroupBy('none')
    state.setSortBy('manual')
    state.setShowSleepingWorkspaces(true)
    const repoId = state.allWorktrees()[0]!.repoId
    const ids: string[] = []
    for (const name of ['reads-main-a', 'reads-main-b', 'reads-main-c']) {
      ids.push((await state.createWorktree(repoId, name, undefined, 'skip')).worktree.id)
    }
    return ids
  })
  try {
    const ours = async (): Promise<string[]> =>
      (await renderedOrder(orcaPage)).filter((id) => created.includes(id))
    await expect.poll(async () => (await ours()).length, { timeout: 30_000 }).toBe(3)
    await orcaPage.screenshot({ path: testInfo.outputPath(`list.png`) })

    // Empty the window's own catalog for one frame: the rows still listed come from main. No
    // refetch can land within the frame.
    const listedInEmptiedFrame = await orcaPage.evaluate(async (selector) => {
      window.__store!.setState({ worktreesByRepo: {} })
      await new Promise((resolve) => requestAnimationFrame(resolve))
      return document.querySelectorAll(selector).length
    }, ROWS)
    expect(listedInEmptiedFrame).toBeGreaterThan(0)
    await orcaPage.evaluate(() => window.__store!.getState().fetchAllWorktrees())
    await expect.poll(async () => (await ours()).length).toBe(3)

    // Drag: every frame after the drop shows the new order; none snaps back.
    const before = await ours()
    const source = before[2]!
    const dragLog = await startFrameLog(orcaPage)
    await dragBefore(orcaPage, source, before[0]!)
    const expected = [source, before[0]!, before[1]!]
    await expect.poll(ours).toEqual(expected)
    await orcaPage.waitForTimeout(400)
    // From the first frame painted after the drop, every frame shows the new order.
    const afterDrop = (await dragLog.stop())
      .filter(({ sinceInput }) => sinceInput !== null)
      .map(({ ids }) => ids.filter((id) => created.includes(id)).join())
    expect(afterDrop.length).toBeGreaterThan(0)
    expect(new Set(afterDrop)).toEqual(new Set([expected.join()]))
    await orcaPage.screenshot({ path: testInfo.outputPath(`after-drag.png`) })

    // Open: the clicked row is highlighted in the frame of the click.
    const openId = expected[1]!
    await orcaPage
      .locator(`${ROWS}[data-worktree-id=${JSON.stringify(openId)}]`)
      .first()
      .click()
    await expect(
      orcaPage.locator(`${ROWS}[data-worktree-id=${JSON.stringify(openId)}][aria-current="page"]`)
    ).toHaveCount(1, { timeout: 1_000 })

    // Cmd/Ctrl+1–9 number the rendered rows.
    const rendered = await renderedOrder(orcaPage)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await orcaPage.keyboard.press(`${modifier}+2`)
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId))
      .toBe(rendered[1])

    // Collapse: the section's rows leave in the next frame, without waiting for main.
    await orcaPage.evaluate(() => window.__store!.getState().setGroupBy('repo'))
    await expect.poll(async () => (await ours()).length).toBe(3)
    const header = orcaPage.locator('[data-worktree-sidebar] [data-repo-header-id][aria-expanded]')
    const collapseLog = await startFrameLog(orcaPage)
    await header.first().click()
    await expect.poll(async () => (await ours()).length).toBe(0)
    // A slow runner can settle the poll before any frame after the click is painted.
    await orcaPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    const collapseFrames = await collapseLog.stop()
    // The first frame painted after the click already has no rows.
    expect(
      collapseFrames
        .find(({ sinceInput }) => sinceInput !== null)
        ?.ids.some((id) => created.includes(id))
    ).toBe(false)
    await header.first().click()
    await expect.poll(async () => (await ours()).length).toBe(3)

    // Create: the pending row hands over to the new row with no frame showing neither.
    await orcaPage.evaluate(() => window.__store!.getState().setGroupBy('none'))
    const name = `reads-main-new-${Date.now()}`
    const createLog = await startFrameLog(orcaPage, name)
    await openSidebarWorkspaceComposer(orcaPage)
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await dialog.getByPlaceholder(/Type a name/i).fill(name)
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    const idOf = (wanted: string): Promise<string | null> =>
      orcaPage.evaluate(
        (suffix) =>
          window
            .__store!.getState()
            .allWorktrees()
            .find((worktree) => worktree.path.endsWith(suffix))?.id ?? null,
        wanted
      )
    await expect.poll(() => idOf(name), { timeout: 30_000 }).not.toBeNull()
    const newId = (await idOf(name))!
    created.push(newId)
    await expect.poll(async () => (await renderedOrder(orcaPage)).includes(newId)).toBe(true)
    await orcaPage.waitForTimeout(300)
    const createFrames = await createLog.stop()
    const pendingShown = createFrames.findIndex(({ shows }) => shows)
    expect(pendingShown).toBeGreaterThanOrEqual(0)
    const handover = createFrames.slice(pendingShown)
    expect(handover.filter(({ ids, shows }) => !shows && !ids.includes(newId))).toEqual([])
    const appeared = handover.findIndex(({ ids }) => ids.includes(newId))
    expect(handover.slice(appeared).every(({ ids }) => ids.includes(newId))).toBe(true)
    await orcaPage.screenshot({ path: testInfo.outputPath(`after-create.png`) })

    // Virtualized scroll and reveal over a list taller than the sidebar.
    const many = await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      const repoId = state.allWorktrees()[0]!.repoId
      const ids: string[] = []
      for (let index = 0; index < 30; index += 1) {
        ids.push(
          (await state.createWorktree(repoId, `reads-main-many-${index}`, undefined, 'skip'))
            .worktree.id
        )
      }
      return ids
    })
    created.push(...many)
    const scroller = orcaPage.locator('[data-worktree-sidebar]')
    await expect
      .poll(async () => many.every((id) => created.includes(id)) && (await ours()).length, {
        timeout: 30_000
      })
      .toBeGreaterThan(0)
    // Scrolled to the end, the last row mounts; back at the top it is not mounted: virtualized.
    let height = -1
    await expect
      .poll(
        async () => {
          const previous = height
          height = await scroller.evaluate((element) => element.scrollHeight)
          return height === previous
        },
        { intervals: [500], timeout: 30_000 }
      )
      .toBe(true)
    await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
    const lastFullyShown = (): Promise<string> =>
      scroller.evaluate((element, selector) => {
        const box = element.getBoundingClientRect()
        const shown = [...element.querySelectorAll<HTMLElement>(selector)].filter((row) => {
          const rect = row.getBoundingClientRect()
          return rect.top >= box.top && rect.bottom <= box.bottom + 1
        })
        return shown.at(-1)?.dataset.worktreeId ?? ''
      }, ROWS)
    await expect.poll(lastFullyShown).not.toBe('')
    const bottomId = await lastFullyShown()
    const bottomRow = orcaPage.locator(`${ROWS}[data-worktree-id=${JSON.stringify(bottomId)}]`)
    await expect(bottomRow).toBeInViewport()
    await scroller.evaluate((element) => element.scrollTo({ top: 0 }))
    await expect(bottomRow).toHaveCount(0)
    await orcaPage.evaluate(
      (id) => window.__store!.getState().revealWorktreeInSidebar(id),
      bottomId
    )
    await expect(bottomRow).toBeInViewport()
    await orcaPage.screenshot({ path: testInfo.outputPath(`after-reveal.png`) })
  } finally {
    for (const id of created) {
      await removeWorktreeViaStore(orcaPage, id).catch(() => {})
    }
  }
})
