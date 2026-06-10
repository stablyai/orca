import { describe, expect, it } from 'vitest'
import { formatBrowserImportSummary } from './browser-detected-browsers-summary'

const SUPPORTED_LABELS = [
  'Google Chrome',
  'Microsoft Edge',
  'Arc',
  'Brave',
  'Comet',
  'Firefox',
  'Safari'
]

describe('formatBrowserImportSummary', () => {
  it('uses real detected browser labels after detection completes', () => {
    expect(
      formatBrowserImportSummary({
        detectedBrowsers: [{ label: 'Google Chrome' }, { label: 'Safari' }],
        detectedBrowsersLoaded: true,
        supportedImportLabels: SUPPORTED_LABELS
      })
    ).toBe('Detected: Google Chrome, Safari.')
  })

  it('summarizes long detected-browser lists with a trailing count', () => {
    expect(
      formatBrowserImportSummary({
        detectedBrowsers: [
          { label: 'Google Chrome' },
          { label: 'Safari' },
          { label: 'Microsoft Edge' },
          { label: 'Arc' },
          { label: 'Firefox' },
          { label: 'Brave' }
        ],
        detectedBrowsersLoaded: true,
        supportedImportLabels: SUPPORTED_LABELS
      })
    ).toBe('Detected: Google Chrome, Safari, Microsoft Edge, Arc, +2 more.')
  })

  it('lists supported import sources before detection runs', () => {
    expect(
      formatBrowserImportSummary({
        detectedBrowsers: [],
        detectedBrowsersLoaded: false,
        supportedImportLabels: SUPPORTED_LABELS
      })
    ).toBe('Import from: Google Chrome, Microsoft Edge, Arc, Brave, +3 more.')
  })

  it('falls back to supported import sources when detection finds nothing', () => {
    expect(
      formatBrowserImportSummary({
        detectedBrowsers: [],
        detectedBrowsersLoaded: true,
        supportedImportLabels: SUPPORTED_LABELS
      })
    ).toBe('Import from: Google Chrome, Microsoft Edge, Arc, Brave, +3 more.')
  })
})
