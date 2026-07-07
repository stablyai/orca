import { describe, expect, it, vi } from 'vitest'

const state = {
  worktreeServicesEnv: {
    'wt-1': { DATABASE_URL: 'pg://localhost:20000/app', ORCA_PORT_0: '20000' }
  } as Record<string, Record<string, string>>
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => state }
}))

import { getWorktreeServiceEnv } from './worktree-service-env-injection'

describe('getWorktreeServiceEnv', () => {
  it('returns the env for a known worktree id', () => {
    expect(getWorktreeServiceEnv('wt-1')).toEqual({
      DATABASE_URL: 'pg://localhost:20000/app',
      ORCA_PORT_0: '20000'
    })
  })

  it('returns {} for an unknown worktree id', () => {
    expect(getWorktreeServiceEnv('wt-nope')).toEqual({})
  })

  it('returns {} for an undefined worktree id', () => {
    expect(getWorktreeServiceEnv(undefined)).toEqual({})
  })
})
