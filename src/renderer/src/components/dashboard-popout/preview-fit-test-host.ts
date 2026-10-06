/** Test-only DOM for the preview fit/claim code: the box, the xterm container inside it, and its `.xterm-screen`. */
export function buildPreviewFitHost(): {
  box: HTMLElement
  container: HTMLElement
  screen: HTMLElement
} {
  const box = document.createElement('div')
  const container = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  box.appendChild(container)
  container.appendChild(screen)
  return { box, container, screen }
}

/** happy-dom has no layout; pin a layout dimension the code under test reads. */
export function dimension(element: HTMLElement, name: string, value: number): void {
  Object.defineProperty(element, name, { configurable: true, value })
}
