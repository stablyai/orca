/**
 * Watches a scenario between checkpoints: samples the runtime's layout against the rules every
 * 100 ms (so a breach that heals before the next step still counts), and counts how many times
 * each pane's terminal view (its xterm) is created in the window.
 */

import type { Page } from '@stablyai/playwright-test'
import {
  checkWorkspaceLayoutRules,
  formatViolations,
  type WorkspaceLayoutPartition
} from './workspace-layout-oracle-model'

const SAMPLE_MS = 100

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    /** Leaf id → xterm instances created for that pane in this renderer. */
    __oracleXtermCreations?: Record<string, number>
  }
}

export class LayoutRuleSampler {
  private running = false
  private loop: Promise<void> | null = null
  /** Breach line → the step label current when it was first seen. */
  readonly seen = new Map<string, string>()
  label = 'start'
  samples = 0

  constructor(private readPartitions: () => Promise<WorkspaceLayoutPartition[]>) {}

  retarget(readPartitions: () => Promise<WorkspaceLayoutPartition[]>): void {
    this.readPartitions = readPartitions
  }

  start(): void {
    this.running = true
    this.loop = (async () => {
      while (this.running) {
        // A read can fail while the app quits or relaunches; the next sample retries.
        const partitions = await this.readPartitions().catch(() => null)
        if (partitions) {
          this.samples += 1
          for (const line of formatViolations(checkWorkspaceLayoutRules(partitions))) {
            if (!this.seen.has(line)) {
              this.seen.set(line, this.label)
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS))
      }
    })()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop
  }

  /** Breaches first seen while `label` was current, removed from the pending set. */
  take(label: string): string[] {
    const lines = [...this.seen].filter(([, seenAt]) => seenAt === label).map(([line]) => line)
    for (const line of lines) {
      this.seen.set(line, `${label} (reported)`)
    }
    return lines
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
