/** Marks a control whose presses leave focus where it is, so outside-press focus release skips it. */
export const KEEPS_FOCUS_ATTRIBUTE = 'data-keeps-focus'

export function isFocusKeepingPress(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${KEEPS_FOCUS_ATTRIBUTE}]`) !== null
}
