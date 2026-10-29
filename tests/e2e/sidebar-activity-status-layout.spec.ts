import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type ActivityState = 'idle' | 'working' | 'blocked'
type CountTypography = {
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  color: string
  textShadow: string
  fontVariantNumeric: string
}

const CASES = [
  { state: 'idle', count: 0 },
  { state: 'working', count: 1 },
  { state: 'working', count: 4 },
  { state: 'working', count: 12 },
  { state: 'working', count: 88 },
  { state: 'working', count: 99 },
  { state: 'working', count: 100 },
  { state: 'blocked', count: 1 },
  { state: 'blocked', count: 12 },
  { state: 'blocked', count: 99 },
  { state: 'blocked', count: 100 }
] as const

async function seedActivity(
  page: Page,
  worktreeId: string,
  state: ActivityState,
  count: number
): Promise<void> {
  await page.evaluate(
    ({ worktreeId, state, count }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const tab = store.getState().tabsByWorktree[worktreeId]?.[0]
      if (!tab) {
        throw new Error('The seeded workspace needs a terminal tab')
      }
      store.setState({
        agentStatusByPaneKey: {},
        retainedAgentsByPaneKey: {},
        acknowledgedAgentsByPaneKey: {}
      })
      if (state === 'idle') {
        return
      }
      const now = Date.now()
      for (let index = 0; index < count; index += 1) {
        const leafId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
        store
          .getState()
          .setAgentStatus(
            `${tab.id}:${leafId}`,
            { state, prompt: `Activity layout ${index}`, agentType: 'codex' },
            'Codex',
            { updatedAt: now, stateStartedAt: now },
            { tabId: tab.id, worktreeId, terminalHandle: `activity-layout-${index}` }
          )
      }
    },
    { worktreeId, state, count }
  )
}

async function expectActivityGeometry(
  button: Locator,
  state: ActivityState,
  count: number,
  referenceTypography: CountTypography,
  referenceLetterSpacing: string
) {
  const label = state === 'blocked' ? 'Needs You' : state === 'working' ? 'Working' : 'Idle'
  const description = button.locator(`[aria-label="${label}: ${count}"]`)
  await expect(description).toHaveText(count > 99 ? '99+' : String(count))

  const geometry = await button.evaluate((element) => {
    const descriptionId = element.getAttribute('aria-describedby')
    const description = descriptionId ? document.getElementById(descriptionId) : null
    const bell = element.querySelector('svg')
    const statusSlot = description?.firstElementChild
    const status = statusSlot?.firstElementChild
    const countSlot = description?.lastElementChild
    const countText = countSlot?.firstElementChild ?? countSlot
    if (!bell || !status || !countSlot || !countText) {
      throw new Error('Activity glyphs are missing')
    }
    const textRange = document.createRange()
    textRange.selectNodeContents(countText)
    const style = getComputedStyle(countText)
    const rect = (value: DOMRect) => ({
      left: value.left,
      right: value.right,
      top: value.top,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
      centerX: value.left + value.width / 2
    })
    return {
      button: rect(element.getBoundingClientRect()),
      bell: rect(bell.getBoundingClientRect()),
      status: rect(status.getBoundingClientRect()),
      count: rect(textRange.getBoundingClientRect()),
      countSlot: rect(countSlot.getBoundingClientRect()),
      countLineBox: rect(countText.getBoundingClientRect()),
      countTypography: {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        color: style.color,
        textShadow: style.textShadow,
        fontVariantNumeric: style.fontVariantNumeric
      },
      letterSpacing: style.letterSpacing
    }
  })

  expect(geometry.button.width, 'The control must leave room for horizontal padding').toBe(32)
  expect(geometry.button.height, 'The control must keep its existing height').toBe(24)
  expect(
    Math.abs(geometry.status.centerX - geometry.count.centerX),
    'The status and actual count text must share a vertical axis'
  ).toBeLessThanOrEqual(0.25)
  expect(geometry.status.bottom, 'The status must clear the count').toBeLessThanOrEqual(
    geometry.countLineBox.top + 0.25
  )
  expect(geometry.bell.left, 'The bell must have horizontal padding').toBe(geometry.button.left + 4)
  expect(geometry.bell.top, 'The bell must retain its vertical position').toBe(
    geometry.button.top + 6
  )
  expect(geometry.bell.width, 'The bell must retain its existing size').toBe(12)
  expect(geometry.bell.height, 'The bell must retain its existing size').toBe(12)
  expect(geometry.countSlot.centerX, 'The count slot must retain its side column').toBe(
    geometry.button.right - 10
  )
  expect(geometry.count.width, 'The count text must be rendered').toBeGreaterThan(0)
  expect(geometry.count.width, 'Keep wider digits within a slight overhang').toBeLessThanOrEqual(
    geometry.countSlot.width + 2
  )
  expect(geometry.count.right, 'Keep text overhang within one pixel').toBeLessThanOrEqual(
    geometry.button.right + 1
  )
  expect(geometry.countTypography, 'Use the same count styling as worktree references').toEqual(
    referenceTypography
  )
  if (count > 9) {
    expect(geometry.letterSpacing, 'Keep the established spacing for multiple digits').toBe(
      referenceLetterSpacing
    )
  }
  for (const [name, glyph] of Object.entries({
    bell: geometry.bell,
    status: geometry.status,
    countSlot: geometry.countSlot
  })) {
    expect(glyph.width, `${name} must be rendered`).toBeGreaterThan(0)
    expect(glyph.left, `${name} must fit the left edge`).toBeGreaterThanOrEqual(
      geometry.button.left - 0.25
    )
    expect(glyph.right, `${name} must fit the right edge`).toBeLessThanOrEqual(
      geometry.button.right + 0.25
    )
    expect(glyph.top, `${name} must fit the top edge`).toBeGreaterThanOrEqual(
      geometry.button.top - 0.25
    )
    expect(glyph.bottom, `${name} must fit the bottom edge`).toBeLessThanOrEqual(
      geometry.button.bottom + 0.25
    )
  }
  // Range height includes unpainted font ascent; the line box owns vertical layout.
  expect(geometry.countLineBox.top).toBeGreaterThanOrEqual(geometry.button.top - 0.25)
  expect(geometry.countLineBox.bottom).toBeLessThanOrEqual(geometry.button.bottom + 0.25)
}

for (const theme of ['dark', 'light'] as const) {
  test(`activity side-column counts align with their status and preserve the control size (${theme})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await orcaPage.evaluate(
      async ({ theme, worktreeId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is unavailable')
        }
        await store.getState().updateSettings({ theme, agentsSidebarIntroShown: true })
        store.getState().setSidebarBody('workspaces')
        store.setState({
          worktreesByRepo: Object.fromEntries(
            Object.entries(store.getState().worktreesByRepo).map(([repoId, worktrees]) => [
              repoId,
              worktrees.map((worktree) =>
                worktree.id === worktreeId
                  ? {
                      ...worktree,
                      linkedItems: Array.from({ length: 12 }, (_, index) => ({
                        provider: 'github' as const,
                        type: 'pr' as const,
                        number: index + 1
                      }))
                    }
                  : worktree
              )
            ])
          )
        })
        await document.fonts.ready
      },
      { theme, worktreeId }
    )
    await expect(orcaPage.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /\blight\b/)
    const referenceCount = orcaPage.locator('[data-reference-count]').first()
    await expect(referenceCount).toHaveText('12')
    const { referenceTypography, referenceLetterSpacing } = await referenceCount.evaluate(
      (element) => {
        const style = getComputedStyle(element)
        return {
          referenceTypography: {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            color: style.color,
            textShadow: style.textShadow,
            fontVariantNumeric: style.fontVariantNumeric
          },
          referenceLetterSpacing: style.letterSpacing
        }
      }
    )

    for (const sidebarBody of ['workspaces', 'agents'] as const) {
      if (sidebarBody === 'agents') {
        await orcaPage.getByRole('button', { name: 'View activity', exact: true }).click()
      }
      const button = orcaPage.getByRole('button', {
        name: sidebarBody === 'agents' ? 'Turn off activity view' : 'View activity',
        exact: true
      })
      await expect(button).toHaveAttribute('aria-pressed', String(sidebarBody === 'agents'))
      await orcaPage.mouse.move(0, 0)
      const background = await button.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      )
      if (sidebarBody === 'agents') {
        expect(background, 'The selected activity control must retain a visible fill').not.toBe(
          'rgba(0, 0, 0, 0)'
        )
      } else {
        expect(background, 'The inactive activity control must stay unfilled').toBe(
          'rgba(0, 0, 0, 0)'
        )
      }
      for (const { state, count } of CASES) {
        await test.step(`${sidebarBody}: ${state} ${count}`, async () => {
          await seedActivity(orcaPage, worktreeId, state, count)
          await expectActivityGeometry(
            button,
            state,
            count,
            referenceTypography,
            referenceLetterSpacing
          )
        })
      }
      await button.screenshot({ path: testInfo.outputPath(`${theme}-${sidebarBody}.png`) })
    }
  })
}
