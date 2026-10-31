type Navigation = {
  reveal: (top: number, bottom: number, policy: number) => void
  scrollBy: (delta: number) => boolean
}
const navigators = new WeakMap<HTMLElement, Navigation>()

export function registerCombinedDiffNavigation(
  node: HTMLElement,
  navigation: Navigation
): () => void {
  navigators.set(node, navigation)
  return () => navigators.delete(node)
}

export function revealCombinedDiffTarget(
  node: HTMLElement,
  top: number,
  bottom: number,
  policy = 2
): boolean {
  const navigation = navigators.get(node)
  if (!navigation) {
    return false
  }
  navigation.reveal(top, bottom, policy)
  return true
}

export function scrollCombinedDiffBy(node: HTMLElement, delta: number): boolean | undefined {
  return navigators.get(node)?.scrollBy(delta)
}
