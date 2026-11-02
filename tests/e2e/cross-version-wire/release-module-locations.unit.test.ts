import { describe, expect, it } from 'vitest'
import { releaseModuleLocation } from './release-module-locations'

const RECORD = 'src/shared/agent-session/lifecycle/agent-session-record.ts'
const EARLIER_RECORD = 'src/shared/agent-session-record.ts'
const holding =
  (...paths: string[]) =>
  (path: string) =>
    paths.some((held) => path.endsWith(held))

describe('release module locations', () => {
  it('loads a moved module from wherever the release defines it, whichever path a suite names', () => {
    for (const named of [RECORD, EARLIER_RECORD, `/${EARLIER_RECORD}`]) {
      expect(releaseModuleLocation('/release', named, holding(EARLIER_RECORD))).toBe(EARLIER_RECORD)
      expect(releaseModuleLocation('/release', named, holding(RECORD))).toBe(RECORD)
    }
  })

  it('passes through paths it does not know or no release defines', () => {
    expect(releaseModuleLocation('/release', 'src/shared/other.ts', holding())).toBe(
      'src/shared/other.ts'
    )
    expect(releaseModuleLocation('/release', RECORD, holding())).toBe(RECORD)
  })
})
