import { COMBINED_DIFF_ROW_SELECTOR } from './combined-diff-viewport'

const owners = new WeakMap<Element, HTMLElement>()
const roots = new WeakMap<HTMLElement, { node: HTMLElement; users: number; x: number; y: number }>()

export function getCombinedDiffFocusOwner(target: Element): HTMLElement | null {
  for (let node: Element | null = target; node; node = node.parentElement) {
    const owner = owners.get(node)
    if (owner) {
      return owner
    }
    if (node.matches(COMBINED_DIFF_ROW_SELECTOR)) {
      return node instanceof HTMLElement ? node : null
    }
  }
  return null
}

export function createCombinedDiffOverflow(
  viewport: HTMLElement,
  row: HTMLElement
): { node: HTMLElement; position: () => void; dispose: () => void } {
  const parent = viewport.parentElement ?? viewport
  let root = roots.get(viewport)
  if (!root) {
    const node = document.createElement('div')
    node.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:20;transform:translate(0px,0px)'
    parent.appendChild(node)
    root = { node, users: 0, x: 0, y: 0 }
    roots.set(viewport, root)
  }
  const shared = root
  shared.users += 1
  const node = document.createElement('div')
  node.className = 'monaco-editor'
  node.style.pointerEvents = 'auto'
  shared.node.appendChild(node)
  owners.set(node, row)
  const position = (): void => {
    // Fixed Monaco coordinates stay in screen space inside transformed dialog boundaries.
    const rect = shared.node.getBoundingClientRect()
    shared.x -= rect.left
    shared.y -= rect.top
    shared.node.style.transform = `translate(${shared.x}px,${shared.y}px)`
  }
  position()
  return {
    node,
    position,
    dispose: () => {
      owners.delete(node)
      node.remove()
      shared.users -= 1
      if (!shared.users) {
        shared.node.remove()
        roots.delete(viewport)
      }
    }
  }
}
