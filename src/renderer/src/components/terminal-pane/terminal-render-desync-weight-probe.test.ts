import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setTerminalWebglDiagnosticRecorder } from '../../../../shared/terminal-webgl-diagnostics'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { applyOrDeferPaneMetricOptions } from '@/lib/pane-manager/pane-metric-options-deferral'
import {
  auditPaneWeightParity,
  readSentinelWeightProbe
} from './terminal-render-desync-weight-probe'

function fakeTerminal(
  overrides: {
    fontWeight?: number | string
    fontWeightBold?: number | string
    atlasConfig?: Record<string, unknown>
    fontProbe?: { count: number; desired: string; actual: string }
  } = {}
) {
  return {
    options: {
      fontWeight: overrides.fontWeight ?? 500,
      fontWeightBold: overrides.fontWeightBold ?? 700
    },
    _core: {
      _renderService: {
        _renderer: {
          value: {
            _charAtlas: {
              _config: overrides.atlasConfig ?? {
                fontWeight: 500,
                fontWeightBold: 700,
                fontFamily: '"SF Mono", Menlo, monospace',
                devicePixelRatio: 2
              },
              ...(overrides.fontProbe
                ? {
                    fontProbeMismatchCount: overrides.fontProbe.count,
                    fontProbeLastMismatch: {
                      desired: overrides.fontProbe.desired,
                      actual: overrides.fontProbe.actual
                    }
                  }
                : {})
            }
          }
        }
      }
    }
  }
}

function fakeBuffer(rows: { chars: string; bold: boolean }[][]) {
  return {
    cursorY: 999,
    viewportY: 0,
    getLine: (y: number) => {
      const row = rows[y]
      if (!row) {
        return undefined
      }
      return {
        getCell: (x: number) =>
          row[x] && {
            getChars: () => row[x].chars,
            getWidth: () => 1,
            isBold: () => (row[x].bold ? 1 : 0)
          },
        translateToString: () => row.map((c) => c.chars).join('')
      }
    }
  }
}

describe('readSentinelWeightProbe', () => {
  it('reads live options, captured atlas config, and a bold census', () => {
    const terminal = fakeTerminal({
      fontWeight: 500,
      atlasConfig: {
        fontWeight: 700,
        fontWeightBold: 700,
        fontFamily: 'Menlo',
        devicePixelRatio: 2
      },
      fontProbe: { count: 3, desired: '500', actual: 'italic 700 28px Menlo' }
    })
    const buffer = fakeBuffer([
      [
        { chars: 'a', bold: false },
        { chars: 'b', bold: true },
        { chars: ' ', bold: false }
      ],
      [{ chars: 'c', bold: true }]
    ])

    const probe = readSentinelWeightProbe(terminal, buffer, 2, 3)

    expect(probe).toEqual({
      optionsFontWeight: '500',
      optionsFontWeightBold: '700',
      atlasConfigFontWeight: '700',
      atlasConfigFontWeightBold: '700',
      atlasConfigFontFamily: 'Menlo',
      atlasConfigDevicePixelRatio: 2,
      boldTextCells: 2,
      totalTextCells: 3,
      fontProbeMismatches: 3,
      fontProbeLastDesired: '500',
      fontProbeLastActual: 'italic 700 28px Menlo'
    })
  })

  it('degrades to nulls when renderer internals are unreachable', () => {
    const probe = readSentinelWeightProbe({ options: {} }, null, 0, 0)

    expect(probe.optionsFontWeight).toBeNull()
    expect(probe.atlasConfigFontWeight).toBeNull()
    expect(probe.fontProbeMismatches).toBeNull()
    expect(probe.totalTextCells).toBe(0)
  })
})

describe('auditPaneWeightParity', () => {
  const recorder = vi.fn()
  const settings = { terminalFontWeight: 500, terminalFontWeightBold: 700 }

  beforeEach(() => {
    recorder.mockClear()
    setTerminalWebglDiagnosticRecorder(recorder)
  })

  function paneWith(options: Record<string, unknown>): ManagedPane {
    return { id: 7, terminal: { options } } as unknown as ManagedPane
  }

  it('records a crumb for a pane whose live weights diverge from settings', () => {
    auditPaneWeightParity([paneWith({ fontWeight: 700, fontWeightBold: 700 })], settings)

    expect(recorder).toHaveBeenCalledWith('terminal-weight-parity-mismatch', {
      paneId: 7,
      liveFontWeight: '700',
      liveFontWeightBold: '700',
      expectedFontWeight: 500,
      expectedFontWeightBold: 700
    })
  })

  it('stays silent for healthy panes', () => {
    auditPaneWeightParity([paneWith({ fontWeight: 500, fontWeightBold: 700 })], settings)

    expect(recorder).not.toHaveBeenCalled()
  })

  it('skips panes with a pending metric deferral (legitimately stale options)', () => {
    const pane = paneWith({ fontWeight: 700, fontWeightBold: 700 })
    applyOrDeferPaneMetricOptions(pane, { fontWeight: 500 }, false)

    auditPaneWeightParity([pane], settings)

    expect(recorder).not.toHaveBeenCalled()
  })
})
