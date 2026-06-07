import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  getOrcaCliFeatureTipTelemetrySource,
  trackCmdJPaletteFeatureTipAcknowledged,
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipSetupClicked,
  trackOrcaCliFeatureTipSetupResult,
  trackOrcaCliFeatureTipShown
} from './feature-tip-telemetry'

describe('feature tip telemetry', () => {
  beforeEach(() => {
    trackMock.mockClear()
  })

  it('keeps feature tip sources low-cardinality', () => {
    expect(getOrcaCliFeatureTipTelemetrySource('app_open')).toBe('app_open')
    expect(getOrcaCliFeatureTipTelemetrySource('settings')).toBe('manual')
    expect(getOrcaCliFeatureTipTelemetrySource(undefined)).toBe('manual')
  })

  it('tracks CLI tip exposure once per explicit call', () => {
    trackOrcaCliFeatureTipShown('app_open')

    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('orca_cli_feature_tip_shown', {
      source: 'app_open'
    })
  })

  it('tracks command palette tip exposure and acknowledgement', () => {
    trackCmdJPaletteFeatureTipShown('app_open')
    trackCmdJPaletteFeatureTipAcknowledged('manual')

    expect(trackMock).toHaveBeenCalledTimes(2)
    expect(trackMock).toHaveBeenNthCalledWith(1, 'cmd_j_palette_feature_tip_shown', {
      source: 'app_open'
    })
    expect(trackMock).toHaveBeenNthCalledWith(2, 'cmd_j_palette_feature_tip_acknowledged', {
      source: 'manual'
    })
  })

  it('tracks setup click and result without raw CLI details', () => {
    trackOrcaCliFeatureTipSetupClicked('app_open')
    trackOrcaCliFeatureTipSetupResult('app_open', 'installed')

    expect(trackMock).toHaveBeenCalledTimes(2)
    expect(trackMock).toHaveBeenNthCalledWith(1, 'orca_cli_feature_tip_setup_clicked', {
      source: 'app_open'
    })
    expect(trackMock).toHaveBeenNthCalledWith(2, 'orca_cli_feature_tip_setup_result', {
      source: 'app_open',
      result: 'installed'
    })
  })
})
