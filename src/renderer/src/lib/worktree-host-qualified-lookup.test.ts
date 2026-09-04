import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../shared/worktree/types'
import { findWorktreeClaimedByNoHost } from './worktree-host-qualified-lookup'

const WT_ID = 'repo-1::/srv/checkout'

function worktreesByRepo(...rows: Partial<Worktree>[]): AppState['worktreesByRepo'] {
  return {
    'repo-1': rows.map((row) => ({ id: WT_ID, repoId: 'repo-1', ...row }) as Worktree)
  }
}

describe('findWorktreeClaimedByNoHost', () => {
  it('answers with the row that names no host, which is what a pty may refine', () => {
    const state = { worktreesByRepo: worktreesByRepo({ path: '/srv/checkout' }) }

    expect(findWorktreeClaimedByNoHost(state, WT_ID)?.path).toBe('/srv/checkout')
  })

  it('refuses a row that already names a host, so no pty can retarget it', () => {
    const state = { worktreesByRepo: worktreesByRepo({ hostId: 'ssh:other' }) }

    expect(findWorktreeClaimedByNoHost(state, WT_ID)).toBeUndefined()
  })

  it('refuses a runtime-owned row for the same reason', () => {
    const state = { worktreesByRepo: worktreesByRepo({ runtimeOwnerEnvironmentId: 'env-1' }) }

    expect(findWorktreeClaimedByNoHost(state, WT_ID)).toBeUndefined()
  })

  // Local and SSH can publish the same worktreeId (store/worktree-repo-index.ts). A hostless
  // twin must not vouch for its stamped rival: the strict host lookup owns that case.
  it('refuses a two-host collision rather than guessing which publication was meant', () => {
    const state = {
      worktreesByRepo: worktreesByRepo({ path: '/srv/checkout' }, { hostId: 'ssh:box' })
    }

    expect(findWorktreeClaimedByNoHost(state, WT_ID)).toBeUndefined()
  })

  it('answers with nothing for a workspace no repo publishes', () => {
    const state = { worktreesByRepo: worktreesByRepo({ path: '/srv/checkout' }) }

    expect(findWorktreeClaimedByNoHost(state, 'repo-1::/srv/gone')).toBeUndefined()
  })
})
