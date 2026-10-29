import type { Page } from '@stablyai/playwright-test'

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

export type ActiveScreen = {
  bufferType: 'normal' | 'alternate'
  rows: string[]
}

// Read only the active viewport: serialize() includes stale normal-buffer markers before the live alt frame (STA-5208).
// Return null during remount because expect.poll aborts on generator throws.
export async function readActiveScreen(page: Page, tabId: string): Promise<ActiveScreen | null> {
  return page.evaluate(
    ({ tabId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        return null
      }
      const buffer = pane.terminal.buffer.active
      const rows: string[] = []
      for (let row = 0; row < pane.terminal.rows; row += 1) {
        rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
      }
      return { bufferType: buffer.type, rows }
    },
    { tabId }
  )
}

// Use the highest frame because a repaint may leave an older marker beside the live one.
export function findMarkerFrame(text: string, marker: string): number | null {
  // marker is a literal, so escape it rather than letting `[`/`.`/`+` act as regex syntax.
  const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} frame (\\d+)`, 'g')
  let latest: number | null = null
  for (const match of text.matchAll(pattern)) {
    const frame = Number(match[1])
    latest = latest === null ? frame : Math.max(latest, frame)
  }
  return latest
}

// Live output and restore paint the same layout; frame number identifies which won.
export async function readRenderedAltScreenFrame(
  page: Page,
  tabId: string,
  marker: string
): Promise<number | null> {
  const screen = await readActiveScreen(page, tabId)
  return screen ? findMarkerFrame(screen.rows.join('\n'), marker) : null
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
