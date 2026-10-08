import { describe, expect, it } from 'vitest'
import { normalizePerforceSettings } from '../../../../../../shared/perforce/perforce-settings'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams
} from './worktree-create-payload'

describe('worktree create payload', () => {
  it('sends the Perforce copy choice only when the composer set one', () => {
    const base = { repoId: 'repo-1', name: 'ws', setupDecision: 'inherit' as const }
    const attempt = { name: 'ws' }
    expect(buildLocalWorktreeCreateArgs(base, attempt).perforceCopy).toBeUndefined()
    const withCopy = buildLocalWorktreeCreateArgs(
      { ...base, options: { perforceCopy: { stream: { kind: 'same-stream' } } } },
      attempt
    )
    expect(withCopy.perforceCopy).toEqual({ stream: { kind: 'same-stream' } })
  })

  it("sends an Orca server the user's copy options with the copy choice", () => {
    const perforceSettings = normalizePerforceSettings({ copyMinFreeSpaceGb: 9 })
    const params = buildRuntimeWorktreeCreateParams(
      {
        repoId: 'repo-1',
        name: 'ws',
        setupDecision: 'inherit',
        options: { perforceCopy: { stream: { kind: 'child' } } },
        perforceSettings
      },
      { name: 'ws' }
    )
    expect(params.perforceCopy).toEqual({ stream: { kind: 'child' }, settings: perforceSettings })
    expect(
      buildLocalWorktreeCreateArgs(
        { repoId: 'repo-1', name: 'ws', setupDecision: 'inherit', perforceSettings },
        { name: 'ws' }
      )
    ).not.toHaveProperty('perforceSettings')
  })
})
