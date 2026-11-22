import { describe, expect, it } from 'vitest'
import {
  initialSliderDraft,
  sliderDraftAfterCommit,
  sliderDraftAfterDrag,
  sliderDraftAfterSettle,
  sliderDraftWithSavedValue
} from './chat-percent-slider-draft'

describe('percent slider draft', () => {
  it('returns to the saved value when its only commit fails', () => {
    const first = {}
    const committed = sliderDraftAfterCommit(initialSliderDraft(40), 60, first)
    expect(sliderDraftAfterSettle(committed, first, 60, false).value).toBe(40)
  })

  it('keeps a drag made after a commit that then fails, even when it lands on the same value', () => {
    const first = {}
    let draft = sliderDraftAfterCommit(initialSliderDraft(40), 60, first)
    draft = sliderDraftAfterDrag(draft, 80)
    draft = sliderDraftAfterDrag(draft, 60)
    expect(sliderDraftAfterSettle(draft, first, 60, false).value).toBe(60)
  })

  it('keeps a drag in progress when an earlier save publishes its value', () => {
    const first = {}
    let draft = sliderDraftAfterCommit(initialSliderDraft(40), 60, first)
    draft = sliderDraftAfterDrag(draft, 80)
    draft = sliderDraftWithSavedValue(draft, 60)
    expect(draft.value).toBe(80)
    expect(sliderDraftAfterSettle(draft, first, 60, true).value).toBe(80)
  })

  it('ignores an older commit settling after a newer one was sent', () => {
    const first = {}
    const second = {}
    let draft = sliderDraftAfterCommit(initialSliderDraft(40), 60, first)
    draft = sliderDraftAfterCommit(sliderDraftAfterDrag(draft, 80), 80, second)
    draft = sliderDraftAfterSettle(draft, first, 60, false)
    expect(draft.value).toBe(80)
    draft = sliderDraftWithSavedValue(draft, 80)
    expect(sliderDraftAfterSettle(draft, second, 80, true).value).toBe(80)
  })

  it('follows a value saved elsewhere while idle', () => {
    expect(sliderDraftWithSavedValue(initialSliderDraft(40), 70).value).toBe(70)
  })
})
