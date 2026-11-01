import { describe, expect, it } from 'vitest'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost,
  type ExecutionHostOwnerRow
} from './worktree-execution-host-resolution'

// Main’s PTY routing and the renderer’s file/reconnect routing must agree; an ID-only repo lookup previously sent ssh:m4air panes to openclaw (#11163, #17799).
const resolve = (
  repos: readonly { id: string; connectionId?: string; executionHostId?: string }[],
  worktree: { repoId: string; hostId?: string | null }
): ReturnType<typeof resolveWorktreeExecutionHost> =>
  resolveWorktreeExecutionHost(createRepoRowExecutionHostLookup(repos as never), worktree) as never

describe('resolveWorktreeExecutionHost', () => {
  describe('the worktree names its own host', () => {
    it('routes to that host even when the only row belongs to a different SSH host', () => {
      expect(
        resolve([{ id: 'r', connectionId: 'openclaw' }], { repoId: 'r', hostId: 'ssh:m4air' })
      ).toEqual({ kind: 'resolved', hostId: 'ssh:m4air', connectionId: 'm4air', owner: null })
    })

    it('picks the row on that host when both SSH hosts carry the id', () => {
      const openclaw = { id: 'r', connectionId: 'openclaw' }
      const m4air = { id: 'r', connectionId: 'm4air' }
      expect(resolve([openclaw, m4air], { repoId: 'r', hostId: 'ssh:m4air' })).toEqual({
        kind: 'resolved',
        hostId: 'ssh:m4air',
        connectionId: 'm4air',
        owner: m4air
      })
      expect(resolve([openclaw, m4air], { repoId: 'r', hostId: 'ssh:openclaw' })).toEqual({
        kind: 'resolved',
        hostId: 'ssh:openclaw',
        connectionId: 'openclaw',
        owner: openclaw
      })
    })

    it('takes no connection from a row on a different host, whatever this host is', () => {
      for (const hostId of ['local', 'runtime:env-a']) {
        expect(resolve([{ id: 'r', connectionId: 'openclaw' }], { repoId: 'r', hostId })).toEqual({
          kind: 'resolved',
          hostId,
          connectionId: null,
          owner: null
        })
      }
    })

    it('reads a runtime host nested SSH target off the row on that same host', () => {
      // Only the same runtime host’s row supplies its nested SSH target; dropping it misroutes transcript reads.
      const nested = { id: 'r', connectionId: 'ssh-nested', executionHostId: 'runtime:env-a' }
      expect(resolve([nested], { repoId: 'r', hostId: 'runtime:env-a' })).toEqual({
        kind: 'resolved',
        hostId: 'runtime:env-a',
        connectionId: 'ssh-nested',
        owner: nested
      })
    })

    it('gives a local row no SSH connection even when it carries a stale one', () => {
      const contradictory = { id: 'r', connectionId: 'openclaw', executionHostId: 'local' }
      expect(resolve([contradictory], { repoId: 'r', hostId: 'local' })).toEqual({
        kind: 'resolved',
        hostId: 'local',
        connectionId: null,
        owner: contradictory
      })
    })
  })

  describe('the worktree names no host', () => {
    it('refuses when rival rows disagree about the host, including two SSH hosts', () => {
      expect(
        resolve(
          [
            { id: 'r', connectionId: 'openclaw' },
            { id: 'r', connectionId: 'm4air' }
          ],
          {
            repoId: 'r'
          }
        )
      ).toEqual({ kind: 'unresolved', reason: 'ambiguous' })
      expect(
        resolve([{ id: 'r', connectionId: 'openclaw' }, { id: 'r' }], { repoId: 'r' })
      ).toEqual({ kind: 'unresolved', reason: 'ambiguous' })
    })

    it('treats the two spellings of one host as agreement, not conflict', () => {
      expect(
        resolve(
          [
            { id: 'r', connectionId: 'm4air' },
            { id: 'r', executionHostId: 'ssh:m4air' }
          ],
          { repoId: 'r' }
        )
      ).toMatchObject({ kind: 'resolved', hostId: 'ssh:m4air', connectionId: 'm4air' })
    })

    // Unknown may fall back to a local folder; a declared but unparseable host must fail closed.
    it('reports a row naming an unparseable host distinctly from an unknown one', () => {
      for (const executionHostId of ['ssh:', 'ssh:a|b', 'ssh:%zz', 'runtime:', 'quantum:box']) {
        expect(resolve([{ id: 'r', executionHostId }], { repoId: 'r' })).toEqual({
          kind: 'unresolved',
          reason: 'malformed'
        })
      }
    })

    it('does not recover a host from the connectionId such a row overrode', () => {
      expect(
        resolve([{ id: 'r', executionHostId: 'ssh:a|b', connectionId: 'openclaw' }], {
          repoId: 'r'
        })
      ).toEqual({ kind: 'unresolved', reason: 'malformed' })
    })
  })

  it('ignores an unparseable host id rather than treating it as a host', () => {
    const row = { id: 'r', connectionId: 'openclaw' }
    expect(resolve([row], { repoId: 'r', hostId: 'ssh:' })).toMatchObject({
      kind: 'resolved',
      connectionId: 'openclaw'
    })
  })
})

describe('createRepoRowExecutionHostLookup', () => {
  /** Rows whose `id` reads are counted, so a rescan of the repo list is observable. */
  const countingRepos = (
    rows: readonly ExecutionHostOwnerRow[]
  ): { repos: ExecutionHostOwnerRow[]; idReads: () => number } => {
    let idReads = 0
    const repos = rows.map(({ id, ...rest }) => ({
      ...rest,
      get id(): string {
        idReads += 1
        return id
      }
    }))
    return { repos, idReads: () => idReads }
  }

  it('scans the repo list once for the factory, never again per lookup', () => {
    const { repos, idReads } = countingRepos([
      { id: 'a' },
      { id: 'b', connectionId: 'm4air' },
      { id: 'c' }
    ])
    const lookup = createRepoRowExecutionHostLookup(repos)
    const afterBuild = idReads()
    expect(afterBuild).toBeLessThanOrEqual(repos.length * 2)

    for (let i = 0; i < 50; i++) {
      lookup.byId('a')
      lookup.byId('missing')
      lookup.byHost('b', 'ssh:m4air')
    }
    expect(idReads()).toBe(afterBuild)
  })
})
