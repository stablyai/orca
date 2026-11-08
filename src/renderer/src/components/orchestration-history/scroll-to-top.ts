/** Module-level so React Compiler does not see a mutation of state. */
export function scrollToTop(element: HTMLElement | null): void {
  if (element) {
    element.scrollTop = 0
  }
}
