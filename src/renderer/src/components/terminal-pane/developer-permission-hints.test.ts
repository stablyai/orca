import { describe, expect, it } from 'vitest'
import { detectDeveloperPermissionHint } from './developer-permission-hints'

describe('detectDeveloperPermissionHint', () => {
  it('detects microphone failures from terminal output', () => {
    expect(
      detectDeveloperPermissionHint('sox WARN coreaudio: default input device permission denied')
        ?.permissionId
    ).toBe('microphone')
  })

  it('detects screen recording failures from terminal output', () => {
    expect(
      detectDeveloperPermissionHint('screencapture failed: screen recording not authorized')
        ?.permissionId
    ).toBe('screen')
  })

  it('ignores unrelated permission text', () => {
    expect(detectDeveloperPermissionHint('git: permission denied (publickey)')).toBeNull()
  })
})
