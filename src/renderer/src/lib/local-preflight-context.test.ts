import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  getLocalPreflightContext,
  getWslDistroFromPath,
  localPreflightContextKey
} from './local-preflight-context'

function makeState(args: { repoPath?: string | null; worktreePath?: string | null }): AppState {
  const repoId = 'repo-1'
  const worktreeId = `${repoId}::worktree-1`
  return {
    activeRepoId: repoId,
    activeWorktreeId: args.worktreePath === undefined ? null : worktreeId,
    repos:
      args.repoPath === undefined
        ? []
        : [
            {
              id: repoId,
              path: args.repoPath
            }
          ],
    worktreesByRepo:
      args.worktreePath === undefined
        ? {}
        : {
            [repoId]: [
              {
                id: worktreeId,
                repoId,
                path: args.worktreePath
              }
            ]
          }
  } as AppState
}

describe('local preflight context', () => {
  it('extracts WSL distro names from supported UNC forms', () => {
    expect(getWslDistroFromPath(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`)).toBe('Ubuntu')
    expect(getWslDistroFromPath(String.raw`\\wsl$\Debian\home\alice\repo`)).toBe('Debian')
    expect(getWslDistroFromPath('/Users/alice/repo')).toBeNull()
  })

  it('returns a stable snapshot for repeated WSL selector reads', () => {
    const state = makeState({
      worktreePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
    })

    const first = getLocalPreflightContext(state)
    const second = getLocalPreflightContext(state)

    expect(first).toBe(second)
    expect(first).toEqual({ wslDistro: 'Ubuntu' })
    expect(localPreflightContextKey(first)).toBe('wsl:Ubuntu')
  })

  it('reuses the same WSL snapshot across equivalent active repo and worktree paths', () => {
    const fromRepo = getLocalPreflightContext(
      makeState({
        repoPath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
      })
    )
    const fromWorktree = getLocalPreflightContext(
      makeState({
        repoPath: '/Users/alice/repo',
        worktreePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
      })
    )
    const fromOtherDistro = getLocalPreflightContext(
      makeState({
        worktreePath: String.raw`\\wsl.localhost\Debian\home\alice\repo`
      })
    )

    expect(fromRepo).toBe(fromWorktree)
    expect(fromOtherDistro).not.toBe(fromRepo)
    expect(fromOtherDistro).toEqual({ wslDistro: 'Debian' })
  })

  it('uses the stable host context for non-WSL paths', () => {
    const state = makeState({ repoPath: '/Users/alice/repo' })

    expect(getLocalPreflightContext(state)).toBeUndefined()
    expect(getLocalPreflightContext(state)).toBeUndefined()
    expect(localPreflightContextKey(getLocalPreflightContext(state))).toBe('host')
  })
})
