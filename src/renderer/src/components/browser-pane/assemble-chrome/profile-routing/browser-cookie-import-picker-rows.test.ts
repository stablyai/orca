import { describe, expect, it } from 'vitest'
import { buildBrowserCookieImportPickerSections } from './browser-cookie-import-picker-rows'
import type { DetectedBrowserEntry } from './browser-toolbar-import-cookies-item'

const BROWSERS: DetectedBrowserEntry[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: [
      { name: 'Person 1', directory: 'Default' },
      { name: 'Client A', directory: 'Profile 1' },
      { name: 'Client B', directory: 'Profile 2' }
    ],
    selectedProfile: 'Default'
  },
  {
    family: 'safari',
    label: 'Safari',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
]

const labels = (sections: ReturnType<typeof buildBrowserCookieImportPickerSections>) =>
  sections.map((s) => [s.browserLabel, s.rows.map((r) => r.label)])

describe('buildBrowserCookieImportPickerSections', () => {
  it('lists a section per browser; a one-profile browser is one row named after it', () => {
    expect(labels(buildBrowserCookieImportPickerSections(BROWSERS, null, ''))).toEqual([
      ['Google Chrome', ['Person 1', 'Client A', 'Client B']],
      ['Safari', ['Safari']]
    ])
  })

  it('puts the last source first as "<Browser> · <Profile>"', () => {
    const sections = buildBrowserCookieImportPickerSections(
      BROWSERS,
      { family: 'chrome', profile: 'Profile 2' },
      ''
    )
    expect(sections[0]).toMatchObject({
      browserLabel: null,
      rows: [
        {
          label: 'Google Chrome · Client B',
          source: { family: 'chrome', profile: 'Profile 2' }
        }
      ]
    })
    // Still listed in its browser's section too, under a distinct highlight identity.
    expect(sections[0].rows[0].value).not.toBe(sections[1].rows[2].value)
  })

  it('names a one-profile last source by its browser alone', () => {
    const sections = buildBrowserCookieImportPickerSections(
      BROWSERS,
      { family: 'safari', profile: null },
      ''
    )
    expect(sections[0].rows[0].label).toBe('Safari')
  })

  it('omits Last used when that browser or profile is gone', () => {
    for (const lastUsed of [
      { family: 'firefox', profile: null },
      { family: 'chrome', profile: 'Profile 9' },
      // Imported when Chrome had one profile; it has several now, so that source is gone.
      { family: 'chrome', profile: null }
    ]) {
      const sections = buildBrowserCookieImportPickerSections(BROWSERS, lastUsed, '')
      expect(sections.map((s) => s.browserLabel)).toEqual(['Google Chrome', 'Safari'])
    }
  })

  it('filters on browser plus profile text, case-insensitively, and hides empty sections', () => {
    const lastUsed = { family: 'chrome', profile: 'Default' }
    expect(labels(buildBrowserCookieImportPickerSections(BROWSERS, lastUsed, 'CLIENT'))).toEqual([
      ['Google Chrome', ['Client A', 'Client B']]
    ])
    expect(labels(buildBrowserCookieImportPickerSections(BROWSERS, lastUsed, 'chrome a'))).toEqual([
      ['Google Chrome', ['Client A']]
    ])
    expect(labels(buildBrowserCookieImportPickerSections(BROWSERS, lastUsed, 'saf'))).toEqual([
      ['Safari', ['Safari']]
    ])
    expect(buildBrowserCookieImportPickerSections(BROWSERS, lastUsed, 'zzz')).toEqual([])
  })
})
