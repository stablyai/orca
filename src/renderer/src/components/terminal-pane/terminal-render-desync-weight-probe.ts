import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { hasDeferredPaneMetricOptions } from '@/lib/pane-manager/pane-metric-options-deferral'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { BufferLike } from './terminal-render-desync-frame'

/**
 * Weight-layer forensics for the terminal bold-collapse bug (STA-4042 family):
 * regular text rasterizing at the bold weight while the byte stream is clean.
 * One capture of these fields discriminates the candidate layers:
 *  - live options poisoned  -> optionsFontWeight is bold-tier
 *  - atlas captured a stale config -> atlasConfig* diverges from options
 *  - renderer buffer cells latched bold -> boldTextCells is viewport-wide
 *  - stuck rasterizer font (failed ctx.font assignment) -> fontProbe* set
 *    (fontProbe fields are maintained by the patched @xterm/addon-webgl atlas)
 */
export type SentinelWeightProbe = {
  optionsFontWeight: string | null
  optionsFontWeightBold: string | null
  atlasConfigFontWeight: string | null
  atlasConfigFontWeightBold: string | null
  atlasConfigFontFamily: string | null
  atlasConfigDevicePixelRatio: number | null
  boldTextCells: number
  totalTextCells: number
  fontProbeMismatches: number | null
  fontProbeLastDesired: string | null
  fontProbeLastActual: string | null
}

type BoldReadableCell = {
  getChars: () => string
  getWidth: () => number
  isBold?: () => number | boolean
}

export function readSentinelWeightProbe(
  terminal: unknown,
  buffer: BufferLike | null,
  rows: number,
  cols: number
): SentinelWeightProbe {
  const term = terminal as {
    options?: { fontWeight?: string | number; fontWeightBold?: string | number }
    _core?: {
      _renderService?: {
        _renderer?: {
          value?: {
            _charAtlas?: {
              _config?: {
                fontWeight?: string | number
                fontWeightBold?: string | number
                fontFamily?: string
                devicePixelRatio?: number
              }
              fontProbeMismatchCount?: number
              fontProbeLastMismatch?: { desired?: string; actual?: string }
            }
          }
        }
      }
    }
  }
  const atlas = term._core?._renderService?._renderer?.value?._charAtlas
  const config = atlas?._config
  const census = countBoldTextCells(buffer, rows, cols)
  return {
    optionsFontWeight: stringOrNull(term.options?.fontWeight),
    optionsFontWeightBold: stringOrNull(term.options?.fontWeightBold),
    atlasConfigFontWeight: stringOrNull(config?.fontWeight),
    atlasConfigFontWeightBold: stringOrNull(config?.fontWeightBold),
    atlasConfigFontFamily: stringOrNull(config?.fontFamily),
    atlasConfigDevicePixelRatio:
      typeof config?.devicePixelRatio === 'number' ? config.devicePixelRatio : null,
    boldTextCells: census.bold,
    totalTextCells: census.total,
    fontProbeMismatches: atlas?.fontProbeMismatchCount ?? null,
    fontProbeLastDesired: atlas?.fontProbeLastMismatch?.desired ?? null,
    fontProbeLastActual: atlas?.fontProbeLastMismatch?.actual ?? null
  }
}

function stringOrNull(value: string | number | undefined): string | null {
  return value === undefined ? null : String(value)
}

/**
 * Reveal-time audit: any pane whose live weight options diverge from the
 * settings-resolved pair has been poisoned by some writer, known or unknown.
 * Runs on the visibility-resume path so every "come back to a finished agent"
 * reveal — the reported trigger for the bold-collapse bug — checks itself.
 * Always on (not sentinel-gated): it reads two option fields per pane and
 * records nothing when healthy, and the poisoning is rare enough that a field
 * occurrence must never be missed because a flag was unset. Panes with a
 * pending metric deferral are skipped — their live options are legitimately
 * stale until the flush, which records its own weight-change crumb.
 * Settings are passed in (not read from the store) so this stays importable
 * from lean unit-test graphs.
 */
export function auditPaneWeightParity(
  panes: Iterable<ManagedPane>,
  settings: { terminalFontWeight?: number; terminalFontWeightBold?: number } | null | undefined
): void {
  if (!settings) {
    return
  }
  const expected = resolveTerminalFontWeights(
    settings.terminalFontWeight,
    settings.terminalFontWeightBold
  )
  for (const pane of panes) {
    if (hasDeferredPaneMetricOptions(pane)) {
      continue
    }
    const live = pane.terminal.options
    const liveWeight = stringOrNull(live.fontWeight)
    const liveBold = stringOrNull(live.fontWeightBold)
    if (
      liveWeight === String(expected.fontWeight) &&
      liveBold === String(expected.fontWeightBold)
    ) {
      continue
    }
    recordTerminalWebglDiagnostic('terminal-weight-parity-mismatch', {
      paneId: pane.id,
      liveFontWeight: liveWeight,
      liveFontWeightBold: liveBold,
      expectedFontWeight: expected.fontWeight,
      expectedFontWeightBold: expected.fontWeightBold
    })
  }
}

/**
 * Census of bold-attributed cells across the visible viewport, read from the
 * renderer's own buffer. The daemon model is clean in every field occurrence,
 * so a viewport-wide bold census here convicts renderer-side cell corruption;
 * a clean census with bold pixels convicts the rasterization layer instead.
 */
function countBoldTextCells(
  buffer: BufferLike | null,
  rows: number,
  cols: number
): { bold: number; total: number } {
  let bold = 0
  let total = 0
  if (!buffer) {
    return { bold, total }
  }
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) {
      continue
    }
    for (let column = 0; column < cols; column++) {
      const cell = line.getCell(column) as BoldReadableCell | undefined
      if (!cell) {
        break
      }
      const chars = cell.getChars()
      if (chars === '' || chars === ' ' || cell.getWidth() === 0) {
        continue
      }
      total++
      if (cell.isBold?.()) {
        bold++
      }
    }
  }
  return { bold, total }
}
