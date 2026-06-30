import { describe, expect, it } from 'vitest'
import {
  toRuntimeTerminalWorktreeSelector,
  toRuntimeWorktreeSelector
} from './runtime-worktree-selector'
import { brandEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'

describe('toRuntimeWorktreeSelector', () => {
  it('addresses raw worktree IDs as runtime ID selectors', () => {
    expect(toRuntimeWorktreeSelector('wt-1')).toBe('id:wt-1')
    expect(toRuntimeWorktreeSelector('repo-1::C:/Users/me/orca/workspaces/orca/new-worktree')).toBe(
      'id:repo-1::C:/Users/me/orca/workspaces/orca/new-worktree'
    )
  })

  it('preserves existing ID selectors and empty values', () => {
    expect(toRuntimeWorktreeSelector('id:wt-1')).toBe('id:wt-1')
    expect(toRuntimeWorktreeSelector('')).toBe('')
  })
})

describe('toRuntimeTerminalWorktreeSelector', () => {
  it('resolves ephemeral setup terminals to the floating-terminal scope', () => {
    expect(
      toRuntimeTerminalWorktreeSelector(
        brandEphemeralSetupTerminalWorktreeId('feature-wall-orchestration-skill-terminal')
      )
    ).toBe('id:global-floating-terminal')
  })

  it('addresses real worktree ids like the base selector', () => {
    expect(toRuntimeTerminalWorktreeSelector('wt-1')).toBe('id:wt-1')
    expect(toRuntimeTerminalWorktreeSelector('id:wt-1')).toBe('id:wt-1')
  })
})
