import type { Page } from '@stablyai/playwright-test'
import { writePtyInputAccepted } from './helpers/terminal-accepted-input'

export type HiddenPressurePane = {
  ptyId: string
}

const HIDDEN_PRESSURE_TARGET_AGGREGATE_CHARS = 12 * 1024 * 1024

export async function startHiddenPressureCommands({
  hiddenPanes,
  orcaPage,
  pressureOutputChars,
  pressureScriptPath,
  pressureStartDelayMs
}: {
  hiddenPanes: HiddenPressurePane[]
  orcaPage: Page
  pressureOutputChars: number
  pressureScriptPath: string
  pressureStartDelayMs: number
}): Promise<void> {
  const outputCharsPerPane = hiddenPressureOutputCharsPerPane(
    pressureOutputChars,
    hiddenPanes.length
  )
  await Promise.all(
    hiddenPanes.map((pane, paneIndex) =>
      writePtyInputAccepted(
        orcaPage,
        pane.ptyId,
        `\x03\x15node ${JSON.stringify(pressureScriptPath)} ${paneIndex} ${outputCharsPerPane} ${pressureStartDelayMs}\r`
      )
    )
  )
}

function hiddenPressureOutputCharsPerPane(requestedChars: number, paneCount: number): number {
  // Why: scale runs should raise PTY count without also multiplying total bytes
  // past the pressure threshold; otherwise restore latency mostly measures IO volume.
  return Math.min(
    requestedChars,
    Math.ceil(HIDDEN_PRESSURE_TARGET_AGGREGATE_CHARS / Math.max(1, paneCount))
  )
}
