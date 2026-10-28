import { describe, expect, it } from 'vitest'
import { isWorktreeCatalogVersionBefore, laterWorktreeCatalogVersion } from './catalog-version'

const host = (sequence: number) => ({ epoch: 'host-a', sequence })
const restarted = (sequence: number) => ({ epoch: 'host-a-restarted', sequence })

describe('WorktreeCatalogVersion ordering', () => {
  it('never calls a restarted host older, whatever its numbers', () => {
    expect(isWorktreeCatalogVersionBefore(restarted(1), host(900))).toBe(false)
    expect(laterWorktreeCatalogVersion(host(900), restarted(1))).toEqual(restarted(1))
  })

  it('keeps the later version when applying', () => {
    expect(laterWorktreeCatalogVersion(undefined, host(2))).toEqual(host(2))
    expect(laterWorktreeCatalogVersion(host(2), host(5))).toEqual(host(5))
    expect(laterWorktreeCatalogVersion(host(5), host(2))).toEqual(host(5))
  })

  it('keeps the held object for an equal version, so a no-op listing patches no state', () => {
    const applied = host(5)
    expect(laterWorktreeCatalogVersion(applied, host(5))).toBe(applied)
  })
})
