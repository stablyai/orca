import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  selectRepoTerminalThemeForWorktree,
  type RepoTerminalThemeSelectionState
} from './repo-terminal-theme-selection'

const LOCAL_THEME = { dark: 'Dracula' }
const SSH_THEME = { dark: 'Nord', light: 'Builtin Tango Light' }

function singleRepoState(
  overrides: Partial<RepoTerminalThemeSelectionState> = {}
): RepoTerminalThemeSelectionState {
  return {
    repos: [
      {
        id: 'repo1',
        path: '/p',
        connectionId: null,
        executionHostId: 'local',
        terminalTheme: LOCAL_THEME
      }
    ],
    ...overrides
  }
}

function duplicateRepoState(
  worktreesByRepo?: RepoTerminalThemeSelectionState['worktreesByRepo']
): RepoTerminalThemeSelectionState {
  return {
    repos: [
      {
        id: 'repo1',
        path: '/p',
        connectionId: null,
        executionHostId: 'local',
        terminalTheme: LOCAL_THEME
      },
      {
        id: 'repo1',
        path: '/p',
        connectionId: 't',
        executionHostId: 'ssh:t',
        terminalTheme: SSH_THEME
      }
    ],
    worktreesByRepo
  }
}

/** A local row carrying a terminalTheme JSON shape the static type cannot express (another build's row). */
function stateWithUnvalidatedTheme(terminalThemeJson: string): RepoTerminalThemeSelectionState {
  const repo: NonNullable<RepoTerminalThemeSelectionState['repos']>[number] = {
    id: 'repo1',
    path: '/p',
    connectionId: null,
    executionHostId: 'local'
  }
  Object.assign(repo, { terminalTheme: JSON.parse(terminalThemeJson) })
  return { repos: [repo] }
}

describe('selectRepoTerminalThemeForWorktree', () => {
  it("returns the owning repo's override for a worktree id", () => {
    expect(selectRepoTerminalThemeForWorktree(singleRepoState(), 'repo1::/p')).toBe(LOCAL_THEME)
  })

  it("returns the owning repo's override for a folder-kind repo instance id", () => {
    expect(
      selectRepoTerminalThemeForWorktree(
        singleRepoState(),
        'repo1::/p::workspace:0f8fad5b-d9cb-469f-a165-70867728950e'
      )
    ).toBe(LOCAL_THEME)
  })

  it('returns undefined for FolderWorkspaces, the floating terminal and empty ids', () => {
    const state = singleRepoState()
    expect(selectRepoTerminalThemeForWorktree(state, 'folder:abc')).toBeUndefined()
    expect(selectRepoTerminalThemeForWorktree(state, FLOATING_TERMINAL_WORKTREE_ID)).toBeUndefined()
    expect(selectRepoTerminalThemeForWorktree(state, null)).toBeUndefined()
  })

  it('returns undefined when the repo has no override or is unknown', () => {
    const state: RepoTerminalThemeSelectionState = {
      repos: [{ id: 'repo1', path: '/p', connectionId: null, executionHostId: 'local' }]
    }
    expect(selectRepoTerminalThemeForWorktree(state, 'repo1::/p')).toBeUndefined()
    expect(selectRepoTerminalThemeForWorktree(state, 'other::/p')).toBeUndefined()
  })

  it('picks the hydrated host owner when a repo id is duplicated across hosts', () => {
    const state = duplicateRepoState({
      repo1: [{ id: 'repo1::/p', repoId: 'repo1', hostId: 'ssh:t' }]
    })
    expect(selectRepoTerminalThemeForWorktree(state, 'repo1::/p')).toBe(SSH_THEME)
  })

  it('returns undefined when duplicate host ownership is ambiguous', () => {
    expect(selectRepoTerminalThemeForWorktree(duplicateRepoState(), 'repo1::/p')).toBeUndefined()
  })

  it('ignores a theme stored on a paired-runtime row, which the settings section cannot edit', () => {
    const state: RepoTerminalThemeSelectionState = {
      repos: [
        {
          id: 'rt-repo',
          path: '/srv/p',
          connectionId: null,
          executionHostId: 'runtime:env-1',
          terminalTheme: LOCAL_THEME
        }
      ]
    }
    expect(selectRepoTerminalThemeForWorktree(state, 'rt-repo::/srv/p')).toBeUndefined()
  })

  it('falls back to global for a stored value of another shape instead of handing it through', () => {
    const state = stateWithUnvalidatedTheme('{"dark":{"name":"Dracula"}}')
    expect(selectRepoTerminalThemeForWorktree(state, 'repo1::/p')).toBeUndefined()
  })

  it('keeps the valid variant of a partly malformed value, with a stable reference', () => {
    const state = stateWithUnvalidatedTheme('{"dark":" Dracula ","light":42}')
    const first = selectRepoTerminalThemeForWorktree(state, 'repo1::/p')
    expect(first).toEqual({ dark: 'Dracula' })
    expect(selectRepoTerminalThemeForWorktree(state, 'repo1::/wt')).toBe(first)
  })

  it('returns the store reference so callers can compare by identity', () => {
    const state = singleRepoState()
    expect(selectRepoTerminalThemeForWorktree(state, 'repo1::/p')).toBe(LOCAL_THEME)
    expect(selectRepoTerminalThemeForWorktree(state, 'repo1::/wt')).toBe(LOCAL_THEME)
  })
})
