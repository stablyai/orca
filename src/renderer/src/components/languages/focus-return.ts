/** The element that has focus now, if it is one worth returning to after a dialog closes. */
export function currentFocusTarget(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/** The first candidate still in the document, for a closing dialog to return focus to. */
export function firstConnected(
  ...candidates: (HTMLElement | null | undefined)[]
): HTMLElement | null {
  return candidates.find((candidate) => candidate?.isConnected) ?? null
}
