import { expect, it } from 'vitest'
import { settingsSectionRevealDelta } from './settings-list-scroll'

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
