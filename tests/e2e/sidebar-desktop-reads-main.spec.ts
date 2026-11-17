// With ORCA_SIDEBAR_INPUTS=main, follow main’s feed while window drag/create/open/collapse changes still commit immediately.
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

/** One committed sidebar DOM state. `afterInput`: committed once the first input began.
 *  `inInputTask`: committed within the task of an input, before any later task could run. */
type DomState = {
  ids: string[]
  shows: boolean
  current: string | null
  afterInput: boolean
  inInputTask: boolean
}

type DomLog = { stop: () => Promise<{ states: DomState[]; inputs: string[] }> }

// Record every committed DOM state within the input task: local changes can commit there, main IPC replies cannot.
// Use committed DOM rather than paint because hidden windows may never paint.
async function startDomLog(page: Page, text = ''): Promise<DomLog> {
  const handle = await page.evaluateHandle(
    ({ selector, wanted }) => {
      const states: (Omit<DomState, 'afterInput' | 'inInputTask'> & { at: number })[] = []
      const inputs: { type: string; at: number; nextTaskAt: number }[] = []
      // Use event time because React may commit before this listener; posted messages close the observation window next task.
      const onInput = (event: Event): void => {
        const input = { type: event.type, at: event.timeStamp, nextTaskAt: Infinity }
        inputs.push(input)
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          input.nextTaskAt = performance.now()
          channel.port1.close()
        }
        channel.port2.postMessage(null)
      }
      // Why drop and dragend: a native drag ends in them, with no mouseup on Linux.
      const events = ['pointerup', 'mouseup', 'click', 'drop', 'dragend']
      for (const type of events) {
        window.addEventListener(type, onInput, true)
      }
      const sidebar = document.querySelector('[data-worktree-sidebar]')
      const record = (): void => {
        const rows = [...document.querySelectorAll<HTMLElement>(selector)].sort(
          (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
        )
        states.push({
          ids: rows.map((row) => row.dataset.worktreeId ?? ''),
          shows: wanted !== '' && (sidebar?.textContent ?? '').includes(wanted),
          current:
            rows.find((row) => row.getAttribute('aria-current') === 'page')?.dataset.worktreeId ??
            null,
          at: performance.now()
        })
      }
      // A mutation callback runs after each commit, so it sees every state React commits.
      const observer = new MutationObserver(record)
      if (sidebar) {
        observer.observe(sidebar, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        })
      }
      record()
      return () => {
        observer.disconnect()
        for (const type of events) {
          window.removeEventListener(type, onInput, true)
        }
        const firstInputAt = inputs[0]?.at ?? Infinity
        return {
          states: states.map(({ at, ...state }) => ({
            ...state,
            afterInput: at >= firstInputAt,
            inInputTask: inputs.some((input) => input.at <= at && at <= input.nextTaskAt)
          })),
          inputs: inputs.map((input) => input.type)
        }
      }
    },
    { selector: ROWS, wanted: text }
  )
  return { stop: () => handle.evaluate((stop) => stop()) }
}

/** The index of the first state after the input that satisfies `reached`, or -1. */
function firstAfterInput(states: DomState[], reached: (state: DomState) => boolean): number {
  return states.findIndex((state) => state.afterInput && reached(state))
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

    // Empty local catalog for one task; main-owned rows must remain before any refetch reply.
    const listedWhileEmptied = await orcaPage.evaluate(async (selector) => {
      window.__store!.setState({ worktreesByRepo: {} })
      await new Promise((resolve) => setTimeout(resolve, 0))
      return document.querySelectorAll(selector).length
    }, ROWS)
    expect(listedWhileEmptied).toBeGreaterThan(0)
    await orcaPage.evaluate(() => window.__store!.getState().fetchAllWorktrees())
    await expect.poll(async () => (await ours()).length).toBe(3)

    // Drag: the new order shows in the drop's own task, and no later state snaps back.
    const before = await ours()
    const source = before[2]!
    const dragLog = await startDomLog(orcaPage)
    await dragBefore(orcaPage, source, before[0]!)
    const expected = [source, before[0]!, before[1]!]
    await expect.poll(ours).toEqual(expected)
    await orcaPage.waitForTimeout(400)
    const drag = await dragLog.stop()
    const oursIn = (state: DomState): string =>
      state.ids.filter((id) => created.includes(id)).join()
    const dropShown = firstAfterInput(drag.states, (state) => oursIn(state) === expected.join())
    expect(dropShown, `inputs seen: ${drag.inputs.join() || 'none'}`).toBeGreaterThanOrEqual(0)
    expect(drag.states[dropShown]!.inInputTask).toBe(true)
    expect(
      drag.states
        .slice(dropShown)
        .map(oursIn)
        .filter((order) => order !== expected.join())
    ).toEqual([])
    await orcaPage.screenshot({ path: testInfo.outputPath(`after-drag.png`) })

    // Open: the clicked row is highlighted in the click's own task.
    const openId = expected[1]!
    const openLog = await startDomLog(orcaPage)
    await orcaPage
      .locator(`${ROWS}[data-worktree-id=${JSON.stringify(openId)}]`)
      .first()
      .click()
    await expect(
      orcaPage.locator(`${ROWS}[data-worktree-id=${JSON.stringify(openId)}][aria-current="page"]`)
    ).toHaveCount(1)
    const openStates = (await openLog.stop()).states
    const opened = firstAfterInput(openStates, (state) => state.current === openId)
    expect(opened).toBeGreaterThanOrEqual(0)
    expect(openStates[opened]!.inInputTask).toBe(true)

    // Cmd/Ctrl+1–9 number the rendered rows.
    const rendered = await renderedOrder(orcaPage)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await orcaPage.keyboard.press(`${modifier}+2`)
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId))
      .toBe(rendered[1])

    // Collapse: the section's rows leave in the click's own task, without waiting for main.
    await orcaPage.evaluate(() => window.__store!.getState().setGroupBy('repo'))
    await expect.poll(async () => (await ours()).length).toBe(3)
    const header = orcaPage.locator('[data-worktree-sidebar] [data-repo-header-id][aria-expanded]')
    const collapseLog = await startDomLog(orcaPage)
    await header.first().click()
    await expect.poll(async () => (await ours()).length).toBe(0)
    const collapseStates = (await collapseLog.stop()).states
    const collapsed = firstAfterInput(
      collapseStates,
      (state) => !state.ids.some((id) => created.includes(id))
    )
    expect(collapsed).toBeGreaterThanOrEqual(0)
    expect(collapseStates[collapsed]!.inInputTask).toBe(true)
    await header.first().click()
    await expect.poll(async () => (await ours()).length).toBe(3)

    // Create: the pending row hands over to the new row with no state showing neither.
    await orcaPage.evaluate(() => window.__store!.getState().setGroupBy('none'))
    const name = `reads-main-new-${Date.now()}`
    const createLog = await startDomLog(orcaPage, name)
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
    const createStates = (await createLog.stop()).states
    const pendingShown = createStates.findIndex(({ shows }) => shows)
    expect(pendingShown).toBeGreaterThanOrEqual(0)
    // The name shows as the pending row before the new row exists.
    expect(createStates[pendingShown]!.ids).not.toContain(newId)
    // The create click's own task lists the pending row, without waiting for main.
    expect(createStates[pendingShown]!.inInputTask).toBe(true)
    const handover = createStates.slice(pendingShown)
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
    // Wait for post-scroll row mounting; initial overscan can still leave the last mounted row mid-viewport.
    const lastRowAtBottom = (): Promise<string> =>
      scroller.evaluate((element, selector) => {
        const box = element.getBoundingClientRect()
        const last = [...element.querySelectorAll<HTMLElement>(selector)]
          .map((row) => ({ row, rect: row.getBoundingClientRect() }))
          .sort((left, right) => left.rect.top - right.rect.top)
          .at(-1)
        if (!last || last.rect.top < box.top || last.rect.bottom > box.bottom + 1) {
          return ''
        }
        return box.bottom - last.rect.bottom < last.rect.height
          ? (last.row.dataset.worktreeId ?? '')
          : ''
      }, ROWS)
    await expect.poll(lastRowAtBottom).not.toBe('')
    const bottomId = await lastRowAtBottom()
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
