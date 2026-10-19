/**
 * Counts how many times each pane's terminal view (its xterm) is created in the window, so a
 * remount outside a relaunch, reload or daemon restart fails.
 */

import type { Page } from '@stablyai/playwright-test'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    /** Leaf id → xterm instances created for that pane in this renderer. */
    __oracleXtermCreations?: Record<string, number>
  }
}

/** Counts xterm creations per pane in this renderer; idempotent, so call it after every launch. */
export function installRemountCounter(page: Page): Promise<void> {
  return page.evaluate(() => {
    if (window.__oracleXtermCreations) {
      return
    }
    const counts: Record<string, number> = {}
    window.__oracleXtermCreations = counts
    const seen = new WeakSet<Element>()
    const count = (xterm: Element): void => {
      if (seen.has(xterm)) {
        return
      }
      const leafId = xterm.closest<HTMLElement>('.pane[data-leaf-id]')?.dataset.leafId
      if (!leafId) {
        // The pane container can get its id just after the xterm mounts.
        requestAnimationFrame(() => count(xterm))
        return
      }
      seen.add(xterm)
      counts[leafId] = (counts[leafId] ?? 0) + 1
    }
    document.querySelectorAll('.xterm').forEach(count)
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            if (node.matches('.xterm')) {
              count(node)
            }
            node.querySelectorAll('.xterm').forEach(count)
          }
        })
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

export function readRemountCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => window.__oracleXtermCreations ?? {})
}
