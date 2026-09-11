import { describe, expect, it } from 'vitest'
import {
  isPreflightRepairRequired,
  toPreflightDetectAgentsParams
} from './web-preflight-detect-params'

describe('web preflight detect params', () => {
  it('sends the named distro so a paired client probes inside WSL', () => {
    expect(toPreflightDetectAgentsParams({ wslDistro: 'Ubuntu-24.04' })).toEqual({
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it('drops a null or blank distro the wire schema would reject', () => {
    expect(toPreflightDetectAgentsParams({ wslDistro: null })).toBeUndefined()
    expect(toPreflightDetectAgentsParams({ wslDistro: '  ' })).toBeUndefined()
    expect(toPreflightDetectAgentsParams(undefined)).toBeUndefined()
  })

  it('forwards the default-distro flag when no distro is named', () => {
    expect(toPreflightDetectAgentsParams({ wslDefault: true })).toEqual({ wslDefault: true })
  })

  it('lets a resolved WSL project runtime pick the distro', () => {
    expect(
      toPreflightDetectAgentsParams({
        wslDistro: 'Ubuntu-22.04',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project-1',
            distro: 'Ubuntu-24.04',
            reason: 'project-override',
            cacheKey: 'project-1:wsl:Ubuntu-24.04'
          }
        }
      })
    ).toEqual({ wslDistro: 'Ubuntu-24.04' })
  })

  it('treats a resolved non-WSL project runtime as host-local', () => {
    expect(
      toPreflightDetectAgentsParams({
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: 'project-1',
            reason: 'global-default',
            cacheKey: 'project-1:windows-host'
          }
        }
      })
    ).toBeUndefined()
  })

  it('flags a repair-required runtime so no probe falls back to the host', () => {
    expect(
      isPreflightRepairRequired({
        wslDistro: 'Ubuntu-24.04',
        projectRuntime: {
          status: 'repair-required',
          repair: {
            projectId: 'project-1',
            preferredRuntime: { kind: 'wsl', distro: null },
            reason: 'wsl-distro-required',
            source: 'project-override',
            cacheKey: 'project-1:repair'
          }
        }
      })
    ).toBe(true)
    expect(isPreflightRepairRequired({ wslDistro: 'Ubuntu-24.04' })).toBe(false)
    expect(isPreflightRepairRequired(undefined)).toBe(false)
  })
})
