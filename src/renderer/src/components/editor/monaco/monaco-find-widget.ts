function getOpenMonacoFindWidget(root: ParentNode | null | undefined): HTMLElement | null {
  if (!root) {
    return null
  }
  const widget = root.querySelector('.find-widget')
  // Use Monaco’s aria-hidden signal so Escape closes find without dismissing a wrapping dialog.
  if (!(widget instanceof HTMLElement) || widget.getAttribute('aria-hidden') === 'true') {
    return null
  }
  return widget
}

export function isMonacoFindWidgetOpen(root: ParentNode | null | undefined): boolean {
  return getOpenMonacoFindWidget(root) !== null
}

function isMonacoFindHostFocused(
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
  // The close command requires editor focus; unfocused widgets need their own close control.
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
