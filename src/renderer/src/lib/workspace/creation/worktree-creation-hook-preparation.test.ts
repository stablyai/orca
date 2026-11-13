import { describe, expect, it } from 'vitest'
import { setupHooksCreateSource } from './worktree-creation-hook-preparation'

describe('setupHooksCreateSource', () => {
  it('reads the named branch only for explicit reuse', () => {
    expect(
      setupHooksCreateSource({
        branchIntent: 'open-existing-v2',
        branchNameOverride: 'feature',
        baseBranch: 'origin/main'
      })
    ).toEqual({ kind: 'branch', ref: 'feature', baseBranch: 'origin/main' })
  })

  it('reads the base when a new branch only borrows the name', () => {
    expect(
      setupHooksCreateSource({
        branchIntent: 'create-new',
        branchNameOverride: 'feature',
        baseBranch: 'origin/main'
      })
    ).toEqual({ kind: 'base', baseBranch: 'origin/main' })
    expect(
      setupHooksCreateSource({ branchNameOverride: 'pr-branch', baseBranch: 'refs/pull/7/head' })
    ).toEqual({ kind: 'base', baseBranch: 'refs/pull/7/head' })
  })
})
