import { describe, expect, it } from 'vitest'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from './worktree-execution-host-resolution'

// Why (#11163, #17799): main's terminal launch scope and the renderer's owner index both answer
// "which host does this worktree execute on". They used to answer it separately, and disagreed —
// main derived the host from the worktree while the renderer fell back to an id-only repo lookup,
// so a pane on one SSH host was routed to another. One rule now, exercised here directly.
const resolve = (
  repos: readonly { id: string; connectionId?: string; executionHostId?: string }[],
  worktree: { repoId: string; hostId?: string | null }
): ReturnType<typeof resolveWorktreeExecutionHost> =>
  resolveWorktreeExecutionHost(createRepoRowExecutionHostLookup(repos as never), worktree) as never

describe('resolveWorktreeExecutionHost', () => {
  describe('the worktree names its own host', () => {
    it('routes to that host even when the only row belongs to a different SSH host', () => {
      // The reproduced defect: `ssh:m4air` worktree, sole row on `openclaw`.
      expect(
        resolve([{ id: 'r', connectionId: 'openclaw' }], { repoId: 'r', hostId: 'ssh:m4air' })
      ).toEqual({ kind: 'resolved', hostId: 'ssh:m4air', connectionId: 'm4air', owner: null })
    })

    it('answers before the repo row hydrates, because the host is not a guess', () => {
      // Deliberate change from "unresolved": #6648 blocks destructive ops while the *host* is
      // unknown. A worktree naming `ssh:m4air` is not that case — the repo row adds nothing the
      // host id has not already settled, and refusing here stalls a remote pane on hydration.
      expect(resolve([], { repoId: 'r', hostId: 'ssh:m4air' })).toEqual({
        kind: 'resolved',
        hostId: 'ssh:m4air',
        connectionId: 'm4air',
        owner: null
      })
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

    it('matches a row that names the host in either spelling', () => {
      const stamped = { id: 'r', executionHostId: 'ssh:m4air' }
      expect(resolve([stamped], { repoId: 'r', hostId: 'ssh:m4air' })).toEqual({
        kind: 'resolved',
        hostId: 'ssh:m4air',
        connectionId: 'm4air',
        owner: stamped
      })
    })

    it('takes no connection from a row on a different host, whatever this host is', () => {
      // The row lives on `ssh:openclaw`; neither a local nor a runtime worktree may borrow it.
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
      // Not a cross-host borrow: this row *is* the runtime host's row, and the nested target
      // appears nowhere else. Nulling it makes the workspace read as local, which decides whether
      // this client tries to read a transcript that lives on the nested host.
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
    it('resolves from the sole row, in either spelling', () => {
      const legacy = { id: 'r', connectionId: 'openclaw' }
      expect(resolve([legacy], { repoId: 'r' })).toEqual({
        kind: 'resolved',
        hostId: 'ssh:openclaw',
        connectionId: 'openclaw',
        owner: legacy
      })
      const stamped = { id: 'r', executionHostId: 'ssh:m4air' }
      expect(resolve([stamped], { repoId: 'r' })).toEqual({
        kind: 'resolved',
        hostId: 'ssh:m4air',
        connectionId: 'm4air',
        owner: stamped
      })
      const local = { id: 'r' }
      expect(resolve([local], { repoId: 'r' })).toEqual({
        kind: 'resolved',
        hostId: 'local',
        connectionId: null,
        owner: local
      })
    })

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

    it('reports an unknown owner distinctly from a conflicting one', () => {
      expect(resolve([], { repoId: 'r' })).toEqual({ kind: 'unresolved', reason: 'unknown' })
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
