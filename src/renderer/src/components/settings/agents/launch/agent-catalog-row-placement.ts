export type AgentCatalogRowHost = ReturnType<typeof createAgentCatalogRowHost>

export function createAgentCatalogRowHost(): {
  element: HTMLDivElement
  place: (parent: HTMLElement, before: HTMLElement | null) => void
} {
  const element = document.createElement('div')
  element.dataset.settingsRow = ''
  // The retained host draws the divider; AgentCatalogRow already supplies the row's padding.
  element.style.paddingBlock = '0'
  let moving = false
  // Register before createPortal installs React's delegated blur handlers on this host.
  for (const name of ['blur', 'focusout', 'focusin']) {
    element.addEventListener(
      name,
      (event) => {
        if (moving) {
          event.stopImmediatePropagation()
        }
      },
      true
    )
  }
  return {
    element,
    place(parent, before) {
      if (element.parentElement === parent && element.nextSibling === before) {
        return
      }
      const atomic =
        element.isConnected && parent.isConnected && typeof parent.moveBefore === 'function'
      const focused = document.activeElement
      const active = focused instanceof HTMLElement && element.contains(focused) ? focused : null
      const selection =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
          ? {
              start: active.selectionStart,
              end: active.selectionEnd,
              direction: active.selectionDirection
            }
          : null
      const offsets = new Map<Element, { top: number; left: number }>()
      for (const start of [element.parentElement, parent]) {
        for (let node = start; node; node = node.parentElement) {
          offsets.set(node, { top: node.scrollTop, left: node.scrollLeft })
        }
      }
      moving = true
      try {
        if (atomic) {
          parent.moveBefore(element, before)
        } else {
          parent.insertBefore(element, before)
        }
        if (active && !atomic) {
          active.focus({ preventScroll: true })
          if (
            selection?.start !== null &&
            selection?.end !== null &&
            selection &&
            (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
          ) {
            active.setSelectionRange(
              selection.start,
              selection.end,
              selection.direction ?? undefined
            )
          }
        }
        for (const [node, offset] of offsets) {
          node.scrollTop = offset.top
          node.scrollLeft = offset.left
        }
      } finally {
        moving = false
      }
    }
  }
}
