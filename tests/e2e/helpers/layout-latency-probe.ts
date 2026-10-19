/**
 * In-app clock for command → drawn layout latency. The window stamps the moment React commits the
 * expected DOM (the MutationObserver callback that first sees it) and the next animation frame,
 * so no DevTools round trip lands inside a sample. The start is stamped in the window too for
 * in-window commands (a keydown, or the call itself); RPC commands are stamped by the test just
 * before sending. All stamps are Date.now() on one machine, so they compare across processes.
 */

import type { Page } from '@stablyai/playwright-test'
import { SORTABLE_TAB } from './terminal-tab-menu'

export type DrawnCondition =
  | { kind: 'panes'; count: number }
  | { kind: 'tabs'; count: number }
  | { kind: 'tabTitle'; title: string }
  | { kind: 'tabOrder'; order: string }

type ProbeState = {
  /** The command asked for confirmation and the probe clicked it: not a latency sample. */
  confirmed: boolean
  startedAt: number | null
  commitAt: number | null
  drawnAt: number | null
  done: Promise<void>
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __layoutLatencyProbe?: ProbeState
  }
}

export type InAppSample = { commitMs: number; drawnMs: number }

export type ArmOptions = {
  /** `keydown` stamps the start on the next non-modifier key; otherwise the sender stamps it. */
  startOn: 'keydown' | 'sender'
  /** A confirmation button the command may raise; the probe clicks it in the window. */
  confirmButton?: string
}

const PROBE_TIMEOUT_MS = 30_000

/** Arms the watch; call right before the command. */
export function armLayoutLatencyProbe(
  page: Page,
  condition: DrawnCondition,
  { startOn, confirmButton }: ArmOptions
): Promise<void> {
  return page.evaluate(
    ({ condition, startOn, confirmButton, tabSelector, timeoutMs }) => {
      const holds = (): boolean => {
        const tabs = (): HTMLElement[] =>
          Array.from(document.querySelectorAll<HTMLElement>(tabSelector))
        switch (condition.kind) {
          case 'panes': {
            const surface = Array.from(
              document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')
            ).find(
              (element) =>
                element.getBoundingClientRect().width > 0 && element.querySelector('.pane')
            )
            return (
              (surface?.querySelectorAll('.pane[data-leaf-id]').length ?? 0) === condition.count
            )
          }
          case 'tabs':
            return tabs().length === condition.count
          case 'tabTitle':
            return tabs().some((tab) => tab.dataset.tabTitle === condition.title)
          case 'tabOrder':
            return (
              tabs()
                .map((tab) => tab.dataset.tabId)
                .join(',') === condition.order
            )
        }
      }
      if (holds()) {
        throw new Error(
          `latency probe: ${JSON.stringify(condition)} already holds before the command`
        )
      }
      const probe: ProbeState = {
        confirmed: false,
        startedAt: null,
        commitAt: null,
        drawnAt: null,
        done: new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            observer.disconnect()
            reject(new Error(`latency probe: ${JSON.stringify(condition)} never drew`))
          }, timeoutMs)
          const observer = new MutationObserver(() => {
            // Stamped before the checks below, whose DOM reads would force layout inside the sample.
            const seenAt = Date.now()
            const confirm = confirmButton
              ? Array.from(document.querySelectorAll('button')).find(
                  (button) => button.textContent?.trim() === confirmButton
                )
              : undefined
            if (confirm && !probe.confirmed) {
              probe.confirmed = true
              confirm.click()
            }
            if (!holds()) {
              return
            }
            observer.disconnect()
            clearTimeout(timer)
            probe.commitAt = seenAt
            requestAnimationFrame(() => {
              probe.drawnAt = Date.now()
              resolve()
            })
          })
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributeFilter: ['data-tab-title']
          })
        })
      }
      if (startOn === 'keydown') {
        // A chord arrives as one keydown per key; the command's key is the first non-modifier.
        const onKeydown = (event: KeyboardEvent): void => {
          if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) {
            return
          }
          probe.startedAt = Date.now()
          window.removeEventListener('keydown', onKeydown, { capture: true })
        }
        window.addEventListener('keydown', onKeydown, { capture: true })
      }
      window.__layoutLatencyProbe = probe
    },
    { condition, startOn, confirmButton, tabSelector: SORTABLE_TAB, timeoutMs: PROBE_TIMEOUT_MS }
  )
}

/**
 * Waits for the armed watch; `sentAt` is the test's stamp for a command it sent itself. Null when
 * the command waited on a confirmation, which measures the click and not the layout.
 */
export async function readLayoutLatencyProbe(
  page: Page,
  sentAt: number
): Promise<InAppSample | null> {
  const stamps = await page.evaluate(async () => {
    const probe = window.__layoutLatencyProbe
    if (!probe) {
      throw new Error('latency probe: not armed')
    }
    await probe.done
    return {
      confirmed: probe.confirmed,
      startedAt: probe.startedAt,
      commitAt: probe.commitAt!,
      drawnAt: probe.drawnAt!
    }
  })
  if (stamps.confirmed) {
    return null
  }
  const startedAt = stamps.startedAt ?? sentAt
  return { commitMs: stamps.commitAt - startedAt, drawnMs: stamps.drawnAt - startedAt }
}
