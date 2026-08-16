/** Resolve DOM constructors from each value's realm; app-level events stay on opener window. */

function realmOf(value: unknown): (Window & typeof globalThis) | null {
  const node = value as Node | null | undefined
  const view = node?.ownerDocument?.defaultView
  if (view) {
    return view as Window & typeof globalThis
  }
  // Documents have no ownerDocument; events carry their view instead.
  const doc = value as Document | null | undefined
  if (doc?.defaultView) {
    return doc.defaultView as Window & typeof globalThis
  }
  const event = value as UIEvent | null | undefined
  if (event?.view) {
    return event.view as Window & typeof globalThis
  }
  return typeof window === 'undefined' ? null : window
}

function isInstanceOf<T>(value: unknown, ctorName: string): value is T {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const realm = realmOf(value)
  const ctor = realm?.[ctorName as keyof typeof realm] as unknown
  if (typeof ctor === 'function' && value instanceof (ctor as new () => unknown)) {
    return true
  }
  // Fall back to the opener's constructor so same-realm values still match when
  // the value carries no usable view (detached nodes, synthetic test doubles).
  const globalCtor = (globalThis as Record<string, unknown>)[ctorName]
  return typeof globalCtor === 'function' && value instanceof (globalCtor as new () => unknown)
}

export function isNode(value: unknown): value is Node {
  return isInstanceOf<Node>(value, 'Node')
}

export function isElement(value: unknown): value is Element {
  return isInstanceOf<Element>(value, 'Element')
}

export function isHTMLElement(value: unknown): value is HTMLElement {
  return isInstanceOf<HTMLElement>(value, 'HTMLElement')
}

export function isHTMLInputElement(value: unknown): value is HTMLInputElement {
  return isInstanceOf<HTMLInputElement>(value, 'HTMLInputElement')
}

export function isHTMLTextAreaElement(value: unknown): value is HTMLTextAreaElement {
  return isInstanceOf<HTMLTextAreaElement>(value, 'HTMLTextAreaElement')
}

export function isInputEvent(value: unknown): value is InputEvent {
  return isInstanceOf<InputEvent>(value, 'InputEvent')
}

export function isCompositionEvent(value: unknown): value is CompositionEvent {
  return isInstanceOf<CompositionEvent>(value, 'CompositionEvent')
}

export function isDocument(value: unknown): value is Document {
  return isInstanceOf<Document>(value, 'Document')
}

/**
 * The focused element in the document that owns `reference`.
 *
 * `document.activeElement` answers for the MAIN document only — while an aux
 * window holds focus the main document reports `<body>`, so any
 * `document.activeElement === paneNode` comparison is permanently false.
 */
export function activeElementFor(reference: Node | null | undefined): Element | null {
  const doc = reference?.ownerDocument ?? (typeof document === 'undefined' ? null : document)
  return doc?.activeElement ?? null
}
