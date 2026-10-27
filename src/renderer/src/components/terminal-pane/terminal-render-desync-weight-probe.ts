import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { hasDeferredPaneMetricOptions } from '@/lib/pane-manager/pane-metric-options-deferral'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { BufferLike } from './terminal-render-desync-frame'

/** Diagnose bold collapse by comparing live weights, atlas config, cell bold census and patched font-assignment probes; each distinguishes option, atlas, model or rasterizer corruption (STA-4042). */
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

/** Always compare reveal-time live weights with settings; skip legitimate pending metric deferrals. Read passed settings to keep unit imports lean, and record nothing on healthy panes. */
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

/** Viewport-wide bold attributes implicate renderer cells; clean cells with bold pixels implicate rasterization. */
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
