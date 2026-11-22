export type ChatPercentSliderDraft = {
  /** The last saved value the slider has seen. */
  saved: number
  value: number
  /** Moved since its last commit. */
  dirty: boolean
  /** The pending commit that owns the shown value, if any. */
  owner: object | null
}

export function initialSliderDraft(value: number): ChatPercentSliderDraft {
  return { saved: value, value, dirty: false, owner: null }
}

/** A newly saved value moves the thumb only while no drag or commit of its own is in flight. */
export function sliderDraftWithSavedValue(
  draft: ChatPercentSliderDraft,
  saved: number
): ChatPercentSliderDraft {
  return draft.dirty || draft.owner ? { ...draft, saved } : { ...draft, saved, value: saved }
}

export function sliderDraftAfterDrag(
  draft: ChatPercentSliderDraft,
  value: number
): ChatPercentSliderDraft {
  return { ...draft, value, dirty: true }
}

export function sliderDraftAfterCommit(
  draft: ChatPercentSliderDraft,
  value: number,
  owner: object
): ChatPercentSliderDraft {
  return { ...draft, value, dirty: false, owner }
}

/** Settles only the latest commit, and keeps any drag made since it was sent. */
export function sliderDraftAfterSettle(
  draft: ChatPercentSliderDraft,
  owner: object,
  committed: number,
  saved: boolean
): ChatPercentSliderDraft {
  if (draft.owner !== owner) {
    return draft
  }
  return {
    ...draft,
    owner: null,
    value: draft.dirty ? draft.value : saved ? committed : draft.saved
  }
}
