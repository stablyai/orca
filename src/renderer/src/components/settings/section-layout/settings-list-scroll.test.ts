import { expect, it } from 'vitest'
import { settingsRevealDelta, settingsSectionRevealDelta } from './settings-list-scroll'

const view = { sectionMarginTop: 32, viewHeight: 300 }

it('only aligns the section when the target already has room below it', () => {
  expect(settingsSectionRevealDelta({ ...view, sectionTop: 500, targetBottom: 700 })).toBe(468)
})

it('gives up some of the padding below the target to keep the section top on screen', () => {
  // 288px from section top to target bottom: both fit with the section at 0 and 12px below the target.
  const delta = settingsSectionRevealDelta({ ...view, sectionTop: 500, targetBottom: 788 })
  expect(500 - delta).toBe(0)
  expect(300 - (788 - delta)).toBe(12)
})

it('keeps the full padding when that still leaves the section top on screen', () => {
  // 260px to the target bottom: 24px below it leaves the section 16px from the top.
  const delta = settingsSectionRevealDelta({ ...view, sectionTop: 500, targetBottom: 760 })
  expect(500 - delta).toBe(16)
  expect(300 - (760 - delta)).toBe(24)
})

it('shows the target with its padding when it cannot fit together with the section top', () => {
  const delta = settingsSectionRevealDelta({ ...view, sectionTop: 500, targetBottom: 900 })
  expect(300 - (900 - delta)).toBe(24)
})

it('only aligns the section when there is no target', () => {
  expect(settingsSectionRevealDelta({ ...view, sectionTop: 500, targetBottom: null })).toBe(468)
})

it('keeps the section top on screen when section and target fit a 200px view (190px apart)', () => {
  const delta = settingsSectionRevealDelta({
    sectionTop: 500,
    sectionMarginTop: 32,
    targetBottom: 690,
    viewHeight: 200
  })
  expect(500 - delta).toBe(0)
  expect(200 - (690 - delta)).toBe(10)
})

it('keeps a target that fits the view fully visible when full padding does not fit (290px in 300px)', () => {
  const delta = settingsRevealDelta({ targetTop: 400, targetHeight: 290, viewHeight: 300 })
  const top = 400 - delta
  expect(top).toBe(5)
  expect(top + 290).toBeLessThanOrEqual(300)
})

it('reveals a fitting target with 24px of room on the edge it enters from', () => {
  expect(settingsRevealDelta({ targetTop: 400, targetHeight: 40, viewHeight: 300 })).toBe(164)
  expect(settingsRevealDelta({ targetTop: -100, targetHeight: 40, viewHeight: 300 })).toBe(-124)
})

it('leaves a target that already has room alone', () => {
  expect(settingsRevealDelta({ targetTop: 100, targetHeight: 40, viewHeight: 300 })).toBe(0)
})

it('shows the top of a target taller than the view', () => {
  expect(settingsRevealDelta({ targetTop: 400, targetHeight: 500, viewHeight: 300 })).toBe(376)
})
