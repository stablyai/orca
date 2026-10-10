/** Liveness: a marker echoed into each visible pane's terminal must show up in that pane. */

import type { Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../../src/cli/runtime/client'

const POLL_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Writes a unique marker into every bound pane the window shows and requires it to appear in
 * that pane's terminal (read from the xterm accessibility tree in the DOM). No pane is a failure.
 */
export async function checkPaneMarkers(
  page: Page,
  client: RuntimeClient,
  worktreeId: string
): Promise<string[]> {
  const listed = await client.call<{
    terminals: { handle: string; tabId: string; leafId: string }[]
  }>('terminal.list', { worktree: `id:${worktreeId}` })
  const mounted = new Set(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.pane[data-leaf-id][data-pty-id]'))
        .filter((pane) => pane.getBoundingClientRect().width > 0)
        .map((pane) => pane.dataset.leafId ?? '')
    )
  )
  const failures: string[] = []
  let checked = 0
  for (const [index, terminal] of listed.result.terminals.entries()) {
    if (!mounted.has(terminal.leafId)) {
      continue
    }
    const marker = `ORACLE_MARK_${Date.now().toString(36)}_${index}`
    await client.call('terminal.send', {
      terminal: terminal.handle,
      text: `echo ${marker}`,
      enter: true
    })
    checked += 1
    const deadline = Date.now() + 10_000
    let shown = false
    while (!shown && Date.now() < deadline) {
      shown = await page.evaluate(
        ({ leafId, text }) => {
          for (const manager of window.__paneManagers?.values() ?? []) {
            for (const pane of manager.getPanes()) {
              if (
                manager.getLeafId(pane.id) === leafId &&
                !pane.terminal.options.screenReaderMode
              ) {
                pane.terminal.options.screenReaderMode = true
                pane.terminal.refresh(0, pane.terminal.rows - 1)
              }
            }
          }
          const node = document.querySelector(
            `.pane[data-leaf-id="${CSS.escape(leafId)}"] .xterm-accessibility-tree`
          )
          return (node?.textContent ?? '').includes(text)
        },
        { leafId: terminal.leafId, text: marker }
      )
      if (!shown) {
        await sleep(POLL_MS)
      }
    }
    if (!shown) {
      failures.push(`pane ${terminal.tabId}:${terminal.leafId} never showed ${marker}`)
    }
  }
  if (checked === 0) {
    failures.push(`no visible pane of ${worktreeId} to write a marker into`)
  }
  return failures
}
