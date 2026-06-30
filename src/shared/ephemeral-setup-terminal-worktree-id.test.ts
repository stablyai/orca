import { describe, expect, it } from 'vitest'
import {
  EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX,
  brandEphemeralSetupTerminalWorktreeId,
  isEphemeralSetupTerminalWorktreeId
} from './ephemeral-setup-terminal-worktree-id'

describe('ephemeral setup terminal worktree id', () => {
  it('brands a panel id with the ephemeral prefix', () => {
    expect(brandEphemeralSetupTerminalWorktreeId('feature-wall-orchestration-skill-terminal')).toBe(
      `${EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX}feature-wall-orchestration-skill-terminal`
    )
  })

  it('is idempotent for already-branded ids', () => {
    const branded = brandEphemeralSetupTerminalWorktreeId('settings-orchestration-skill-terminal')
    expect(brandEphemeralSetupTerminalWorktreeId(branded)).toBe(branded)
  })

  it('recognizes branded ids and rejects real worktree ids', () => {
    expect(
      isEphemeralSetupTerminalWorktreeId(
        brandEphemeralSetupTerminalWorktreeId('feature-tip-cli-skills-terminal')
      )
    ).toBe(true)
    expect(isEphemeralSetupTerminalWorktreeId('repo-1::/work/orca/wt')).toBe(false)
    expect(isEphemeralSetupTerminalWorktreeId('global-floating-terminal')).toBe(false)
  })

  it('does not introduce the `::` worktree id separator', () => {
    expect(brandEphemeralSetupTerminalWorktreeId('onboarding-inline-terminal')).not.toContain('::')
  })
})
