// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  closeMonacoFindWidget,
  closeUnfocusedMonacoFindOrPreventDialogDismiss,
  isMonacoFindHostFocused,
  isMonacoFindWidgetOpen
} from './monaco-find-widget'

function appendFindWidget(
  root: ParentNode,
  args: { hidden?: boolean; withCloseButton?: boolean } = {}
): { closeButton: HTMLButtonElement | null; widget: HTMLDivElement } {
  const widget = document.createElement('div')
  widget.className = 'find-widget visible'
  if (args.hidden) {
    widget.setAttribute('aria-hidden', 'true')
  }
  let closeButton: HTMLButtonElement | null = null
  if (args.withCloseButton) {
    closeButton = document.createElement('button')
    closeButton.className = 'button codicon-widget-close'
    widget.append(closeButton)
  }
  root.append(widget)
  return { closeButton, widget }
}

describe('isMonacoFindWidgetOpen', () => {
  it('is closed when the widget is missing or aria-hidden', () => {
    const root = document.createElement('div')
    expect(isMonacoFindWidgetOpen(null)).toBe(false)
    expect(isMonacoFindWidgetOpen(root)).toBe(false)

    appendFindWidget(root, { hidden: true })
    expect(isMonacoFindWidgetOpen(root)).toBe(false)
  })

  it('is open when the find widget is present and not hidden', () => {
    const root = document.createElement('div')
    appendFindWidget(root)
    expect(isMonacoFindWidgetOpen(root)).toBe(true)
  })

  it('does not treat a find widget outside the given root as open', () => {
    const dialog = document.createElement('div')
    const editorRoot = document.createElement('div')
    const backgroundEditor = document.createElement('div')
    dialog.append(editorRoot)
    document.body.append(dialog, backgroundEditor)
    appendFindWidget(backgroundEditor)
    expect(isMonacoFindWidgetOpen(editorRoot)).toBe(false)
    expect(isMonacoFindWidgetOpen(document)).toBe(true)
    dialog.remove()
    backgroundEditor.remove()
  })
})

describe('isMonacoFindHostFocused', () => {
  it('is true only when the event target is inside the host', () => {
    const host = document.createElement('div')
    const inside = document.createElement('input')
    const outside = document.createElement('input')
    host.append(inside)
    expect(isMonacoFindHostFocused(host, inside)).toBe(true)
    expect(isMonacoFindHostFocused(host, outside)).toBe(false)
    expect(isMonacoFindHostFocused(null, inside)).toBe(false)
  })
})

describe('closeMonacoFindWidget', () => {
  it('clicks the close control on an open widget', () => {
    const root = document.createElement('div')
    const { closeButton } = appendFindWidget(root, { withCloseButton: true })
    const onClick = vi.fn()
    closeButton?.addEventListener('click', onClick)

    expect(closeMonacoFindWidget(root)).toBe(true)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does nothing when find is closed or the close control is missing', () => {
    const root = document.createElement('div')
    expect(closeMonacoFindWidget(root)).toBe(false)

    appendFindWidget(root, { hidden: true, withCloseButton: true })
    expect(closeMonacoFindWidget(root)).toBe(false)

    const openRoot = document.createElement('div')
    appendFindWidget(openRoot)
    expect(closeMonacoFindWidget(openRoot)).toBe(false)
  })
})

describe('closeUnfocusedMonacoFindOrPreventDialogDismiss', () => {
  it('holds the dialog when find is open and the host is focused', () => {
    const root = document.createElement('div')
    const { closeButton } = appendFindWidget(root, { withCloseButton: true })
    const findInput = document.createElement('input')
    root.append(findInput)
    const onClick = vi.fn()
    closeButton?.addEventListener('click', onClick)

    expect(
      closeUnfocusedMonacoFindOrPreventDialogDismiss({
        root,
        eventTarget: findInput
      })
    ).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('closes find and lets the dialog dismiss when find is open but unfocused', () => {
    const root = document.createElement('div')
    const { closeButton } = appendFindWidget(root, { withCloseButton: true })
    const nameField = document.createElement('input')
    const onClick = vi.fn()
    closeButton?.addEventListener('click', onClick)

    expect(
      closeUnfocusedMonacoFindOrPreventDialogDismiss({
        root,
        eventTarget: nameField
      })
    ).toBe(false)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('lets the dialog dismiss when this host has no open find', () => {
    const root = document.createElement('div')
    const outside = document.createElement('div')
    appendFindWidget(outside, { withCloseButton: true })

    expect(
      closeUnfocusedMonacoFindOrPreventDialogDismiss({
        root,
        eventTarget: document.createElement('input')
      })
    ).toBe(false)
  })
})
