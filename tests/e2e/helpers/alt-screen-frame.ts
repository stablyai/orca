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

export type ActiveScreen = {
  bufferType: 'normal' | 'alternate'
  rows: string[]
}

// Why: what the pane shows is the active buffer's viewport. `serializeAddon.serialize()`
// dumps the whole normal buffer (scrollback included) before the alt frame, so a stale
// marker there is indistinguishable from the live one (STA-5208). Null on a missing pane
// because callers poll this and `expect.poll` aborts on a generator throw.
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

// Why the highest match rather than the first: a repaint can leave an older marker line
// beside the live one, and only the newest frame says which paint landed last.
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

// Why: the live-write and the reveal restore paint the same layout, so the frame
// number is the only thing on screen that says which of the two landed last.
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
