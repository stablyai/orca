function getOpenMonacoFindWidget(root: ParentNode | null | undefined): HTMLElement | null {
  if (!root) {
    return null
  }
  const widget = root.querySelector('.find-widget')
  // Why: Monaco marks the find widget `aria-hidden="true"` while closed; the
  // e2e probe uses the same signal so Escape can close find without dismissing
  // a wrapping dialog.
  if (!(widget instanceof HTMLElement) || widget.getAttribute('aria-hidden') === 'true') {
    return null
  }
  return widget
}

export function isMonacoFindWidgetOpen(root: ParentNode | null | undefined): boolean {
  return getOpenMonacoFindWidget(root) !== null
}

export function isMonacoFindHostFocused(
  root: ParentNode | null | undefined,
  eventTarget: EventTarget | null | undefined
): boolean {
  return root instanceof Element && eventTarget instanceof Node && root.contains(eventTarget)
}

export function closeMonacoFindWidget(root: ParentNode | null | undefined): boolean {
  const widget = getOpenMonacoFindWidget(root)
  if (!widget) {
    return false
  }
  // Why: CloseFindWidgetCommand only runs while the editor has focus, so an
  // unfocused widget has to be closed through its own close control.
  const closeButton = widget.querySelector<HTMLElement>('.codicon-widget-close')
  if (!closeButton) {
    return false
  }
  closeButton.click()
  return true
}

export function closeUnfocusedMonacoFindOrPreventDialogDismiss(args: {
  root: ParentNode | null | undefined
  eventTarget: EventTarget | null | undefined
}): boolean {
  if (!isMonacoFindWidgetOpen(args.root)) {
    return false
  }
  if (isMonacoFindHostFocused(args.root, args.eventTarget)) {
    return true
  }
  closeMonacoFindWidget(args.root)
  return false
}
