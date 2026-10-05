/**
 * Counts how many tab-strip tabs each React commit re-renders, the way React DevTools highlights
 * updates: through the commit hook the renderer always installs.
 */

import type { Page } from '@stablyai/playwright-test'

type Fiber = {
  tag: number
  flags: number
  child: Fiber | null
  sibling: Fiber | null
  stateNode: unknown
}

export type ReactCommitHook = {
  onCommitFiberRoot?: (rendererId: unknown, root: { current: Fiber }, ...rest: unknown[]) => unknown
}

/** Commits that render no tab (the sidebar, terminals starting up) are left out. */
export async function startRecordingTabRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Function, class, forwardRef and memo components; bit 1 is React's PerformedWork flag.
    const componentTags = new Set([0, 1, 11, 14, 15])
    const performedWork = 1
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
    if (!hook) {
      throw new Error('React commit hook is not installed')
    }
    const original = hook.onCommitFiberRoot
    // A subtree React skipped keeps last commit's fiber objects, whose flags are stale. Per root: the renderer mounts several.
    const previousFibersByRoot = new WeakMap<object, Set<Fiber>>()
    const recorded: number[] = []
    window.__tabsRenderedPerCommit = recorded
    hook.onCommitFiberRoot = function (rendererId, root, ...rest) {
      const previousFibers = previousFibersByRoot.get(root)
      const fibers = new Set<Fiber>()
      const renderedTabIds = new Set<string>()
      const stack: Fiber[] = [root.current]
      while (stack.length > 0) {
        const fiber = stack.pop()!
        fibers.add(fiber)
        if (
          componentTags.has(fiber.tag) &&
          (fiber.flags & performedWork) === performedWork &&
          !previousFibers?.has(fiber)
        ) {
          let host: Fiber | null = fiber
          while (host && host.tag !== 5) {
            host = host.child
          }
          const element = host?.stateNode
          const tabId =
            element instanceof Element
              ? element.closest('[data-tab-strip-slot]')?.getAttribute('data-tab-strip-slot')
              : undefined
          if (tabId) {
            renderedTabIds.add(tabId)
          }
        }
        if (fiber.sibling) {
          stack.push(fiber.sibling)
        }
        if (fiber.child) {
          stack.push(fiber.child)
        }
      }
      previousFibersByRoot.set(root, fibers)
      if (renderedTabIds.size > 0) {
        recorded.push(renderedTabIds.size)
      }
      return original?.call(this, rendererId, root, ...rest)
    }
  })
}

/** Tabs re-rendered by each commit since the last call. */
export async function takeTabRenders(page: Page): Promise<number[]> {
  return page.evaluate(() => window.__tabsRenderedPerCommit?.splice(0) ?? [])
}
