import { describe, expect, it } from 'vitest'
import {
  initialSliderDraft,
  sliderDraftAfterCommit,
  sliderDraftAfterDrag,
  sliderDraftAfterRelease,
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

  it('follows saved values again after a drag released where it began', () => {
    let draft = sliderDraftAfterDrag(initialSliderDraft(40), 60)
    draft = sliderDraftAfterRelease(sliderDraftAfterDrag(draft, 40))
    expect(sliderDraftWithSavedValue(draft, 70).value).toBe(70)
  })

  it('leaves a commit made on release in charge of the thumb', () => {
    const first = {}
    let draft = sliderDraftAfterCommit(sliderDraftAfterDrag(initialSliderDraft(40), 60), 60, first)
    draft = sliderDraftAfterRelease(draft)
    expect(draft.value).toBe(60)
    expect(sliderDraftAfterSettle(draft, first, 60, true).value).toBe(60)
  })

  it('follows a value saved elsewhere while idle', () => {
    expect(sliderDraftWithSavedValue(initialSliderDraft(40), 70).value).toBe(70)
  })
})
