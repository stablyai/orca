import type { Page } from '@stablyai/playwright-test'

// Boxed alt-screen TUI frame: enters the alternate buffer, clears it, and paints
// a marker line carrying a zero-padded frame number.
export function buildAltScreenFrame(marker: string, frame: number): string {
  const progress = `${'█'.repeat((frame % 8) + 1)}${'░'.repeat(8 - ((frame % 8) + 1))}`
  return [
    '\x1b[?2026h',
    '\x1b[?1049h',
    '\x1b[2J\x1b[H',
    '\x1b[?25l',
    `╭────────────────────────────────────────────────────────────────────╮`,
    `│ ${marker} frame ${String(frame).padStart(3, '0')} ${progress}                     │`,
    `│ Dimension              │ Rating                                      │`,
    `╰────────────────────────────────────────────────────────────────────╯`,
    '\x1b[?2026l'
  ].join('\r\n')
}

// Why: the live-write and the reveal restore paint the same layout, so the frame
// number is the only thing on screen that says which of the two landed last.
export async function readRenderedAltScreenFrame(
  page: Page,
  tabId: string,
  marker: string
): Promise<number | null> {
  return page.evaluate(
    ({ tabId, marker }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
      if (!pane) {
        throw new Error(`No terminal pane for tab ${tabId}`)
      }
      // marker is a literal, so escape it rather than letting `[`/`.`/`+` act as regex syntax.
      const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} frame (\\d{3})`)
      const buffer = pane.terminal.buffer.active
      for (let row = 0; row < pane.terminal.rows; row += 1) {
        const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
        const match = pattern.exec(line)
        if (match) {
          return Number(match[1])
        }
      }
      return null
    },
    { tabId, marker }
  )
}

export function describeAltScreenRenderPath(
  renderedFrame: number | null,
  liveFrame: number,
  restoreFrame: number
): string {
  if (renderedFrame === restoreFrame) {
    return 'reveal restore'
  }
  if (renderedFrame === liveFrame) {
    return 'live write (no restore)'
  }
  return renderedFrame === null ? 'no marker' : `unexpected frame ${renderedFrame}`
}

export async function writeToPaneTerminal(page: Page, tabId: string, data: string): Promise<void> {
  await page.evaluate(
    ({ tabId, data }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
      if (!pane) {
        throw new Error(`No terminal pane for tab ${tabId}`)
      }
      return new Promise<void>((resolve) => pane.terminal.write(data, resolve))
    },
    { tabId, data }
  )
}
