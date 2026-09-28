// Why: windows opened via window.open (the floating-workspace popout) run a
// separate JS realm — main-window instanceof misses their nodes, so resolve
// DOM constructors from the node's own view instead of the global one. Each
// lookup falls back to the global constructor, keeping main-document behavior
// identical and tolerating nodes without an ownerDocument (e.g. test fakes).
// Why getters: resolving eagerly would evaluate every global up front, which
// breaks DOM-less (node) test doubles that stub only the constructor they use.
export function getDomRealm(view: Window | null | undefined): {
  readonly Element: typeof Element
  readonly Node: typeof Node
  readonly HTMLElement: typeof HTMLElement
  getComputedStyle: (el: Element) => CSSStyleDeclaration
} {
  // Why the cast: TS types Window without its realm constructors, but every
  // real window (and the global scope) carries them.
  const realm = view as unknown as typeof globalThis | null | undefined
  return {
    get Element(): typeof Element {
      return realm?.Element ?? Element
    },
    get Node(): typeof Node {
      return realm?.Node ?? Node
    },
    get HTMLElement(): typeof HTMLElement {
      return realm?.HTMLElement ?? HTMLElement
    },
    getComputedStyle: (el) => (realm ? realm.getComputedStyle(el) : getComputedStyle(el))
  }
}
