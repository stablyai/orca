import { describe, expect, it } from 'vitest'
import {
  getSidebarProjectDropAffordance,
  isRemoteRuntimeActive,
  resolveSidebarProjectDropPath
} from './sidebar-project-drop'

describe('resolveSidebarProjectDropPath', () => {
  it('accepts exactly one dropped path', () => {
    expect(resolveSidebarProjectDropPath(['/Users/alice/repo'])).toEqual({
      status: 'ready',
      path: '/Users/alice/repo'
    })
  })

  it('rejects empty and multi-path drops before routing', () => {
    expect(resolveSidebarProjectDropPath([])).toEqual({ status: 'empty' })
    expect(resolveSidebarProjectDropPath(['/repo/a', '/repo/b'])).toEqual({
      status: 'multiple',
      count: 2
    })
  })
})

describe('isRemoteRuntimeActive', () => {
  it('distinguishes local runtime from active server runtime', () => {
    expect(isRemoteRuntimeActive(null)).toBe(false)
    expect(isRemoteRuntimeActive({ activeRuntimeEnvironmentId: '   ' })).toBe(false)
    expect(isRemoteRuntimeActive({ activeRuntimeEnvironmentId: 'server-1' })).toBe(true)
  })
})

describe('getSidebarProjectDropAffordance', () => {
  it('hides when the sidebar is not in a drop interaction', () => {
    expect(
      getSidebarProjectDropAffordance({
        isDragOver: false,
        isHandlingDrop: false,
        remoteRuntimeActive: false
      })
    ).toEqual({ visible: false })
  })

  it('shows ready, busy, and blocked states', () => {
    expect(
      getSidebarProjectDropAffordance({
        isDragOver: true,
        isHandlingDrop: false,
        remoteRuntimeActive: false
      })
    ).toMatchObject({ visible: true, tone: 'ready' })

    expect(
      getSidebarProjectDropAffordance({
        isDragOver: false,
        isHandlingDrop: true,
        remoteRuntimeActive: false
      })
    ).toMatchObject({ visible: true, tone: 'busy' })

    expect(
      getSidebarProjectDropAffordance({
        isDragOver: true,
        isHandlingDrop: false,
        remoteRuntimeActive: true
      })
    ).toMatchObject({ visible: true, tone: 'blocked' })
  })
})
