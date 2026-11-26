import { afterEach, describe, expect, it, vi } from 'vitest'
import { regionalDateTimeFormat, setOsDateTimeRegion } from './regional-date-time-format'

// Guards #50045 (issue #49899): dates are formatted per row and per render, so the shared formatter must build
// each formatter and locale plan once, and keep a bounded number of them.
afterEach(() => setOsDateTimeRegion(null))

describe('regionalDateTimeFormat cache', () => {
  it('works out the language and region once, and reuses a formatter per explicit zone', () => {
    setOsDateTimeRegion({ region: 'BR', hourCycle: null })
    regionalDateTimeFormat({ hour: 'numeric' }, 'ko')
    const locales = vi.spyOn(Intl, 'Locale')
    try {
      for (let index = 0; index < 50; index++) {
        regionalDateTimeFormat({ month: 'short', hour: 'numeric' }, 'ko')
      }
      expect(locales).not.toHaveBeenCalled()
    } finally {
      locales.mockRestore()
    }
    const run = { dateStyle: 'medium' } as const
    expect(regionalDateTimeFormat(run, 'ko', 'Asia/Tokyo')).toBe(
      regionalDateTimeFormat(run, 'ko', 'Asia/Tokyo')
    )
  })

  it('keeps a bounded number of formatters per options as languages come and go', () => {
    const options = { hour: 'numeric' } as const
    const first = regionalDateTimeFormat(options, 'en')
    expect(regionalDateTimeFormat(options, 'en')).toBe(first)
    for (let index = 0; index < 50; index++) {
      regionalDateTimeFormat(options, `en-x-pack${index}`)
    }
    // Evicted, so rebuilt: the cache did not keep all 51 languages.
    expect(regionalDateTimeFormat(options, 'en')).not.toBe(first)
  })
})
