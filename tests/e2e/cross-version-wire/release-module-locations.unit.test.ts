import { describe, expect, it } from 'vitest'
import { releaseModuleLocation, type ReleaseTree } from './release-module-locations'

const CURRENT = 'src/shared/agent-session/lifecycle/agent-session-record.ts'
const SHIPPED = 'src/shared/agent-session-record.ts'
const release = (...files: string[]): ReleaseTree => ({
  exists: (path) => files.includes(path),
  list: (directory) => files.filter((file) => file.startsWith(`${directory}/`))
})

describe('release module locations', () => {
  it('loads a moved module from wherever the release defines it, whichever path a suite names', () => {
    for (const named of [CURRENT, SHIPPED, `/${SHIPPED}`]) {
      expect(releaseModuleLocation('/release', named, release(SHIPPED))).toBe(SHIPPED)
      expect(releaseModuleLocation('/release', named, release(CURRENT))).toBe(CURRENT)
    }
  })

  it('stays inside the named source root and passes ambiguous or absent names through', () => {
    expect(
      releaseModuleLocation('/release', CURRENT, release('src/main/agent-session-record.ts'))
    ).toBe(CURRENT)
    expect(
      releaseModuleLocation(
        '/release',
        CURRENT,
        release(SHIPPED, 'src/shared/old/agent-session-record.ts')
      )
    ).toBe(CURRENT)
    expect(releaseModuleLocation('/release', CURRENT, release())).toBe(CURRENT)
  })
})
