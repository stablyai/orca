import { describe, expect, it } from 'vitest'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { parentWorktreeForRunOn, runOnHonoursParentWorktree } from './cloud-advanced-options'

describe('composer Advanced options on Orca Cloud (DS-j)', () => {
  it('offers a parent worktree everywhere but Orca Cloud', () => {
    expect(runOnHonoursParentWorktree(null)).toBe(true)
    expect(runOnHonoursParentWorktree(undefined)).toBe(true)
    expect(runOnHonoursParentWorktree('my-recipe')).toBe(true)
    expect(runOnHonoursParentWorktree(ORCA_CLOUD_RECIPE_ID)).toBe(false)
  })

  it('never sends a parent picked before switching Run on to Orca Cloud', () => {
    expect(parentWorktreeForRunOn(ORCA_CLOUD_RECIPE_ID, 'wt-parent')).toBeUndefined()
    expect(parentWorktreeForRunOn(null, 'wt-parent')).toBe('wt-parent')
    expect(parentWorktreeForRunOn('my-recipe', 'wt-parent')).toBe('wt-parent')
  })
})
