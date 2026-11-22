/** Flushes pending style changes so the next one starts a CSS transition. A call, unlike a bare
 *  `void el.offsetWidth`, survives React Compiler's dead-read removal. */
export function forceLayoutReflow(element: HTMLElement | null | undefined): number | undefined {
  return element?.offsetWidth
}
