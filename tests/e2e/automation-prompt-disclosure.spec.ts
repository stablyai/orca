import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const SHORT_NAME = 'synthetic-short-prompt-demo'
const RESIZE_NAME = 'synthetic-resize-prompt-demo'
const LONG_NAME = 'visual-proof-long-prompt-demo'
const END_MARKER = 'SYNTHETIC-END-MARKER'
const RESIZE_PROMPT = `Synthetic resize focus validation. ${'placeholder '.repeat(24)}`

test('automation detail keeps short prompts readable and reveals a very long prompt at narrow width', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 820, height: 700 })

  await orcaPage.evaluate(
    async ({ shortName, resizeName, resizePrompt, longName, endMarker }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const repo = store.getState().repos[0]
      if (!repo) {
        throw new Error('Seeded test repo is not available')
      }
      const base = {
        agentId: 'codex' as const,
        projectId: repo.id,
        workspaceMode: 'new_per_run' as const,
        reuseSession: false,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: Date.now(),
        enabled: false,
        missedRunGraceMinutes: 720
      }
      const createAutomation = async (input: typeof base & { name: string; prompt: string }) => {
        const response = await window.api.runtime.call({
          method: 'automation.create',
          params: {
            ...input,
            // Runtime RPC resolves the project selector and stores the resulting
            // host/workspace context; the removed preload CRUD method did this
            // implicitly for old E2E fixtures.
            repo: `id:${input.projectId}`
          }
        })
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
      }
      await createAutomation({
        ...base,
        name: shortName,
        prompt: 'Synthetic short prompt.'
      })
      await createAutomation({
        ...base,
        name: longName,
        prompt: [
          'Synthetic prompt preview validation only.',
          '',
          ...Array.from(
            { length: 20 },
            (_, index) =>
              `Synthetic step ${index + 1}: inspect placeholder input and summarize placeholder output.`
          ),
          '',
          `UNBROKEN_SYNTHETIC_${'X'.repeat(240)}`,
          '',
          endMarker
        ].join('\n')
      })
      await createAutomation({
        ...base,
        name: resizeName,
        prompt: resizePrompt
      })
      store.getState().openAutomationsPage()
    },
    {
      shortName: SHORT_NAME,
      resizeName: RESIZE_NAME,
      resizePrompt: RESIZE_PROMPT,
      longName: LONG_NAME,
      endMarker: END_MARKER
    }
  )

  await orcaPage.getByRole('button', { name: new RegExp(`^${SHORT_NAME}`) }).click()
  await expect(orcaPage.getByText('Synthetic short prompt.')).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Show more' })).toHaveCount(0)

  await orcaPage.getByRole('button', { name: 'All automations' }).click()
  await orcaPage.getByRole('button', { name: new RegExp(`^${RESIZE_NAME}`) }).click()
  const resizePrompt = orcaPage.getByText(RESIZE_PROMPT)
  const resizeToggle = orcaPage.getByRole('button', { name: 'Show more' })
  await expect(resizeToggle).toBeVisible()
  await resizeToggle.focus()
  await orcaPage.setViewportSize({ width: 1400, height: 700 })
  await expect(resizeToggle).toHaveCount(0)
  await expect(resizePrompt).toBeFocused()

  await orcaPage.setViewportSize({ width: 820, height: 700 })
  await orcaPage.getByRole('button', { name: 'All automations' }).click()
  await orcaPage.getByRole('button', { name: new RegExp(`^${LONG_NAME}`) }).click()

  const prompt = orcaPage.getByText(new RegExp(END_MARKER))
  const showMore = orcaPage.getByRole('button', { name: 'Show more' })
  await expect(showMore).toBeVisible()
  expect(await showMore.getAttribute('aria-controls')).toBe(await prompt.getAttribute('id'))
  const collapsedMetrics = await prompt.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    lineClamp: getComputedStyle(element).webkitLineClamp
  }))
  expect(collapsedMetrics.scrollHeight).toBeGreaterThan(collapsedMetrics.clientHeight)
  expect(collapsedMetrics.lineClamp).toBe('4')

  await showMore.focus()
  await orcaPage.keyboard.press('Enter')
  await expect(orcaPage.getByRole('button', { name: 'Show less' })).toBeFocused()

  const expandedMetrics = await prompt.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    lineClamp: getComputedStyle(element).webkitLineClamp,
    overflowWrap: getComputedStyle(element).overflowWrap
  }))
  expect(expandedMetrics.clientHeight).toBeGreaterThan(80)
  expect(expandedMetrics.scrollHeight).toBeLessThanOrEqual(expandedMetrics.clientHeight + 1)
  expect(expandedMetrics.scrollWidth).toBeLessThanOrEqual(expandedMetrics.clientWidth + 1)
  expect(expandedMetrics.lineClamp).toBe('none')
  expect(expandedMetrics.overflowWrap).toBe('anywhere')

  const markerProof = await prompt.evaluate(async (element, marker) => {
    const text = element.firstChild
    if (!(text instanceof Text)) {
      throw new Error('Prompt text node is unavailable')
    }
    const start = text.data.indexOf(marker)
    if (start === -1) {
      throw new Error('Prompt end marker is unavailable')
    }
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + marker.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const scrollContainer = element.closest('[role="tabpanel"]')
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error('Automation overview scroll container is unavailable')
    }
    scrollContainer.scrollTop +=
      range.getBoundingClientRect().bottom - scrollContainer.getBoundingClientRect().bottom + 16
    await new Promise(requestAnimationFrame)
    const markerRect = range.getBoundingClientRect()
    const containerRect = scrollContainer.getBoundingClientRect()
    return {
      selectedText: selection?.toString(),
      markerTop: markerRect.top,
      markerBottom: markerRect.bottom,
      visibleTop: containerRect.top,
      visibleBottom: containerRect.bottom
    }
  }, END_MARKER)
  expect(markerProof.selectedText).toBe(END_MARKER)
  expect(markerProof.markerTop).toBeGreaterThanOrEqual(markerProof.visibleTop)
  expect(markerProof.markerBottom).toBeLessThanOrEqual(markerProof.visibleBottom)
})
