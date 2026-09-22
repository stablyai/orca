import { vi } from 'vitest'
import { hookRuntime } from './floating-terminal-panel-test-harness'
import type { FloatingTerminalPanelBounds } from './floating-terminal-panel-bounds'

export type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  if (!element.props) {
    return
  }
  cb(element)
  visit(element.props.children, cb)
}

export function findByTypeName(node: unknown, typeName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    const candidate =
      typeof entry.type === 'function' || typeof entry.type === 'object'
        ? ((entry.type as { displayName?: string; name?: string }).displayName ??
          (entry.type as { displayName?: string; name?: string }).name ??
          '')
        : entry.type
    if (candidate === typeName) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${typeName} not found`)
  }
  return found
}

export function findAllByTypeName(node: unknown, typeName: string): ReactElementLike[] {
  const found: ReactElementLike[] = []
  visit(node, (entry) => {
    const candidate =
      typeof entry.type === 'function' || typeof entry.type === 'object'
        ? ((entry.type as { displayName?: string; name?: string }).displayName ??
          (entry.type as { displayName?: string; name?: string }).name ??
          '')
        : entry.type
    if (candidate === typeName) {
      found.push(entry)
    }
  })
  return found
}

export function findByProp(node: unknown, propName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props[propName]) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${propName} not found`)
  }
  return found
}

export function collectPropValues(node: unknown, propName: string): unknown[] {
  const values: unknown[] = []
  visit(node, (entry) => {
    const value = entry.props[propName]
    if (value !== undefined) {
      values.push(value)
    }
  })
  return values
}

export function runEffects(): void {
  const layoutEffects = hookRuntime.layoutEffects.splice(0)
  for (const effect of layoutEffects) {
    effect()
  }
  const effects = hookRuntime.effects.splice(0)
  for (const effect of effects) {
    effect()
  }
}

export function attachRef(ref: unknown, value: unknown): void {
  if (typeof ref === 'function') {
    ref(value)
    return
  }
  ;(ref as { current: unknown }).current = value
}

export async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

export async function renderPanel(
  open: boolean,
  onOpenChange: (open: boolean) => void = vi.fn(),
  tourInteractionSnapshot?: {
    wasPreviouslyInteracted: boolean
    persisted?: Promise<void>
    recordFeatureInteractionForTour: boolean
  } | null
): Promise<unknown> {
  hookRuntime.index = 0
  const { FloatingTerminalPanel } = await import('./FloatingTerminalPanel')
  return FloatingTerminalPanel({ open, onOpenChange, tourInteractionSnapshot })
}

export function getPanelStyleBounds(element: unknown): FloatingTerminalPanelBounds {
  const panel = findByProp(element, 'data-floating-terminal-panel')
  const style = panel.props.style as Record<string, number>
  return {
    left: style.left,
    top: style.top,
    width: style.width,
    height: style.height
  }
}

export function getPanelClassName(element: unknown): string {
  const panel = findByProp(element, 'data-floating-terminal-panel')
  return panel.props.className as string
}

export function getMockedLocalStorage(): {
  clear: ReturnType<typeof vi.fn>
  getItem: ReturnType<typeof vi.fn>
  setItem: ReturnType<typeof vi.fn>
} {
  return window.localStorage as unknown as {
    clear: ReturnType<typeof vi.fn>
    getItem: ReturnType<typeof vi.fn>
    setItem: ReturnType<typeof vi.fn>
  }
}

export function setViewport(width: number, height: number): void {
  const viewport = window as unknown as { innerHeight: number; innerWidth: number }
  viewport.innerWidth = width
  viewport.innerHeight = height
}

export function makeMacShortcutKeyEvent({
  key,
  preventDefault = vi.fn(),
  shiftKey = false,
  target
}: {
  key: string
  preventDefault?: () => void
  shiftKey?: boolean
  target: unknown
}): unknown {
  const nativeEvent = {
    altKey: false,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: false,
    key,
    metaKey: true,
    shiftKey,
    target: target as EventTarget
  }
  return {
    ...nativeEvent,
    defaultPrevented: false,
    nativeEvent,
    preventDefault,
    repeat: false
  }
}

export function bindFocusedFloatingPanelKeydown(element: unknown): {
  keydownListener: (event: unknown) => void
  panelElement: {
    contains: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    closest: ReturnType<typeof vi.fn>
  }
} {
  const panel = findByProp(element, 'data-floating-terminal-panel')
  const panelElement = {
    contains: vi.fn().mockReturnValue(true),
    focus: vi.fn(),
    closest: vi.fn()
  }
  panelElement.closest.mockImplementation((selector: string) =>
    selector === '[data-floating-terminal-panel]' ? panelElement : null
  )
  Object.setPrototypeOf(panelElement, HTMLElement.prototype)
  attachRef(panel.props.ref, panelElement)
  vi.stubGlobal('document', {
    activeElement: panelElement,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  runEffects()
  const keydownListener = vi.mocked(window.addEventListener).mock.calls.find(([type]) => {
    return type === 'keydown'
  })?.[1] as ((event: unknown) => void) | undefined
  if (!keydownListener) {
    throw new Error('keydown listener not registered')
  }
  return { keydownListener, panelElement }
}

export function makeFocusedPanelKeyEvent({
  altKey = false,
  code,
  ctrlKey = false,
  key,
  metaKey = false,
  preventDefault = vi.fn(),
  shiftKey = false,
  stopImmediatePropagation = vi.fn(),
  stopPropagation = vi.fn(),
  target
}: {
  altKey?: boolean
  code?: string
  ctrlKey?: boolean
  key: string
  metaKey?: boolean
  preventDefault?: () => void
  shiftKey?: boolean
  stopImmediatePropagation?: () => void
  stopPropagation?: () => void
  target: unknown
}): unknown {
  return {
    altKey,
    code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
    ctrlKey,
    defaultPrevented: false,
    key,
    metaKey,
    preventDefault,
    repeat: false,
    shiftKey,
    stopImmediatePropagation,
    stopPropagation,
    target
  }
}
