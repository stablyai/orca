/** Back-stack navigation over visited wiki notes, always holding at least the root note. */
export type WikiHistory = {
  current: () => string
  canGoBack: () => boolean
  push: (relativePath: string) => void
  back: () => void
  home: () => void
}

/** Creates a `WikiHistory` stack seeded with the given root note. */
export function createWikiHistory(root: string): WikiHistory {
  const stack: string[] = [root]
  return {
    // Why: stack always holds at least root; fall back to root to keep a definite string.
    current: () => stack.at(-1) ?? root,
    canGoBack: () => stack.length > 1,
    push: (relativePath) => {
      if (stack.at(-1) !== relativePath) {
        stack.push(relativePath)
      }
    },
    back: () => {
      if (stack.length > 1) {
        stack.pop()
      }
    },
    home: () => {
      stack.length = 1
    }
  }
}
