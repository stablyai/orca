import type { Page } from '@stablyai/playwright-test'
import {
  REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT,
  REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT
} from '../../../src/renderer/src/constants/terminal'

// Input-to-drawn latency of one layout action, timed in the page: from the input until the change
// is in the store and on screen, plus one frame so it is drawn.

export type LayoutAction =
  | 'newTab'
  | 'split'
  | 'closePane'
  | 'tabSwitch'
  | 'reorder'
  | 'workspaceSwitch'
  | 'openFile'
  | 'rename'

/** Nearest-rank percentile of `samples`. */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

/** Times `action` until its change is in the store and the page, then one more frame so it is drawn.
 *  With `drawn: false` (a window that draws no frames) it stops at the change, polled per task. */
export async function timeLayoutAction(
  page: Page,
  name: LayoutAction,
  arg: unknown = null,
  { drawn = true }: { drawn?: boolean } = {}
): Promise<number> {
  return page.evaluate(
    async ({ name, arg, drawn, splitEvent, closeEvent }) => {
      const S = window.__store!
      const st = () => S.getState()
      const wt = st().activeWorktreeId as string
      const tick = () =>
        new Promise<void>((r) => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => r()
          channel.port2.postMessage(null)
        })
      const frame = drawn ? () => new Promise<void>((r) => requestAnimationFrame(() => r())) : tick
      const until = async (done: () => boolean) => {
        const deadline = performance.now() + 15_000
        while (!done()) {
          if (performance.now() > deadline) {
            throw new Error(
              `${name} timed out: ${JSON.stringify({ tab: st().activeTabId, tabs: tabs().length, panes: panes(), xterms: xterms() })}`
            )
          }
          await frame()
        }
        if (drawn) {
          await frame()
        }
      }
      const tabs = () => (st().tabsByWorktree[wt] ?? []) as { id: string }[]
      const panes = () => window.__paneManagers?.get(st().activeTabId)?.getPanes().length ?? 0
      const xterms = () => document.querySelectorAll('.xterm').length
      const text = (s: string) => document.body.innerText.includes(s)
      let t0 = 0
      switch (name) {
        case 'newTab': {
          const before = tabs().length
          const find = (re: RegExp) =>
            [...document.querySelectorAll('button')].find((b) =>
              re.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim())
            ) as HTMLButtonElement | undefined
          if (!find(/^New Terminal/i)) {
            const trigger = find(/^New tab$/)
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              trigger?.dispatchEvent(
                new PointerEvent(type, { bubbles: true, button: 0, pointerType: 'mouse' })
              )
            }
            const until2 = performance.now() + 5_000
            while (!find(/^New Terminal/i) && performance.now() < until2) {
              await frame()
            }
          }
          const button = find(/^New Terminal/i)
          if (!button) {
            throw new Error('no New Terminal button')
          }
          t0 = performance.now()
          button.click()
          await until(() => tabs().length > before && panes() > 0)
          break
        }
        case 'split': {
          const tabId = st().activeTabId
          const before = panes()
          const x = xterms()
          t0 = performance.now()
          window.dispatchEvent(
            new CustomEvent(splitEvent, { detail: { tabId, direction: 'vertical' } })
          )
          await until(() => panes() > before && xterms() > x)
          break
        }
        case 'closePane': {
          const tabId = st().activeTabId
          const before = panes()
          t0 = performance.now()
          window.dispatchEvent(new CustomEvent(closeEvent, { detail: { tabId } }))
          await until(() => panes() < before)
          break
        }
        case 'tabSwitch': {
          const target = (arg as string[]).find((id) => id !== st().activeTabId)!
          t0 = performance.now()
          st().activateTab(target)
          await until(() => {
            const m = window.__paneManagers?.get(target)
            const el = m?.getPanes()[0]?.container as HTMLElement | undefined
            return st().activeTabId === target && !!el && el.offsetParent !== null
          })
          break
        }
        case 'reorder': {
          const group = (st().groupsByWorktree?.[wt] ?? [])[0] as { id: string; tabOrder: string[] }
          const order = group.tabOrder.toReversed()
          const firstTitle = () =>
            ([...document.querySelectorAll('[data-tab-id]')][0] as HTMLElement | undefined)?.dataset
              .tabId
          const before = firstTitle()
          t0 = performance.now()
          st().reorderUnifiedTabs(group.id, order)
          await until(() => firstTitle() !== before)
          break
        }
        case 'workspaceSwitch': {
          const target = (arg as string[]).find((id) => id !== st().activeWorktreeId)!
          t0 = performance.now()
          st().setActiveWorktree(target)
          await until(() => {
            if (st().activeWorktreeId !== target) {
              return false
            }
            const tabId = st().activeTabId
            const el = window.__paneManagers?.get(tabId)?.getPanes()[0]?.container as
              | HTMLElement
              | undefined
            return !!el && el.offsetParent !== null
          })
          break
        }
        case 'openFile': {
          const { filePath, firstLine } = arg as { filePath: string; firstLine: string }
          t0 = performance.now()
          st().openFile({
            filePath,
            relativePath: filePath.split(/[\\/]/).pop() ?? filePath,
            worktreeId: wt,
            language: 'plaintext',
            mode: 'edit'
          })
          await until(() => {
            return [...document.querySelectorAll('.monaco-editor .view-lines')].some(
              (lines) =>
                (lines as HTMLElement).offsetParent !== null &&
                (lines.textContent ?? '').replace(/\u00a0/g, ' ').includes(firstLine)
            )
          })
          break
        }
        case 'rename': {
          const title = `r-${Math.random().toString(36).slice(2, 8)}`
          t0 = performance.now()
          st().setTabCustomTitle(st().activeTabId, title)
          await until(() => text(title))
          break
        }
        default:
          throw new Error(name)
      }
      return performance.now() - t0
    },
    {
      name,
      arg,
      drawn,
      splitEvent: REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
      closeEvent: REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT
    }
  )
}
