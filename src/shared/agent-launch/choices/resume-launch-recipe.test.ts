import { describe, expect, it } from 'vitest'
import { resolveResumeLaunchRecipe } from './resume-launch-recipe'

const session = { key: 'session_id', id: 'abc' } as const

describe('resolveResumeLaunchRecipe without a recorded launch', () => {
  it('resumes a Claude that reported bypass with the bypass flag', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', {
        ...session,
        permissionMode: 'bypassPermissions'
      })
    ).toEqual({ agentArgs: '--dangerously-skip-permissions', agentEnv: {} })
  })

  it('resumes bare when the session reported another mode or none', () => {
    for (const permissionMode of ['default', undefined]) {
      expect(
        resolveResumeLaunchRecipe(undefined, 'claude', {
          ...session,
          ...(permissionMode ? { permissionMode } : {})
        })
      ).toEqual({ agentArgs: '', agentEnv: {} })
    }
  })
})
