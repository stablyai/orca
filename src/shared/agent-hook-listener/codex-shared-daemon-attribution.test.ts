import { describe, expect, it } from 'vitest'
import {
  attributeCodexDaemonHook,
  attributeCodexSharedDaemonHookBody,
  mergeRelayAgentHookRequest,
  type CodexDaemonHookPane
} from './codex-shared-daemon-attribution'

const A = 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'tab-b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'tab-c:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const WT_A = 'repo::/work/a'
const WT_B = 'repo::/work/b'

function decide(cwd: string | undefined, panes: CodexDaemonHookPane[] | null, stamped = A) {
  return attributeCodexDaemonHook({
    cwd,
    stampedPaneKey: stamped,
    stampedWorktreeId: stamped === A ? WT_A : WT_B,
    panes
  })
}

/** A pane running a Codex client, or (codex=false) a shell / dev server with none. */
function pane(paneKey: string | null, worktreeId: string, codex = true): CodexDaemonHookPane {
  return { paneKey, worktreeId, runsCodexClient: codex }
}

describe('attributeCodexDaemonHook', () => {
  const twoWorktrees = [pane(A, WT_A), pane(B, WT_B)]

  it('keeps the stamp when the session runs in the stamped pane worktree', () => {
    expect(decide('/work/a/src', twoWorktrees)).toEqual({ kind: 'keep' })
  })

  it('moves a session in another worktree to that worktree Codex pane', () => {
    expect(decide('/work/b', twoWorktrees)).toEqual({
      kind: 'rebind',
      paneKey: B,
      worktreeId: WT_B
    })
  })

  it('ignores shell splits beside the Codex pane of the session worktree', () => {
    const panes = [pane(A, WT_A), pane(B, WT_B), pane(C, WT_B, false)]
    expect(decide('/work/b', panes)).toEqual({ kind: 'rebind', paneKey: B, worktreeId: WT_B })
  })

  it('never rebinds to a shell pane; the only Codex pane keeps a session run elsewhere', () => {
    expect(decide('/work/b', [pane(A, WT_A), pane(B, WT_B, false)])).toEqual({ kind: 'keep' })
  })

  it('keeps the only Codex session when it was launched outside every worktree', () => {
    expect(decide('/Users/me/proj', [pane(A, WT_A)])).toEqual({ kind: 'keep' })
  })

  it('moves a session to the only Codex pane when the daemon starter no longer runs Codex', () => {
    expect(decide('/Users/me/proj', [pane(A, WT_A, false), pane(B, WT_B)])).toEqual({
      kind: 'rebind',
      paneKey: B,
      worktreeId: WT_B
    })
  })

  it('drops a session outside every worktree when several Codex panes could own it', () => {
    expect(decide('/Users/me/proj', twoWorktrees)).toEqual({ kind: 'drop' })
  })

  it('does not match a sibling directory that only shares a prefix', () => {
    expect(decide('/work/bb', twoWorktrees)).toEqual({ kind: 'drop' })
  })

  it('prefers the deepest worktree for a linked worktree nested in the main checkout', () => {
    const panes = [pane(A, 'repo::/work/a'), pane(B, 'repo::/work/a/.worktrees/feature')]
    expect(decide('/work/a/.worktrees/feature/src', panes)).toEqual({
      kind: 'rebind',
      paneKey: B,
      worktreeId: 'repo::/work/a/.worktrees/feature'
    })
  })

  it('drops when several Codex panes share the session worktree and none is the stamp', () => {
    expect(decide('/work/b', [...twoWorktrees, pane(C, WT_B)])).toEqual({ kind: 'drop' })
  })

  it('keeps the stamp among several Codex panes of the same worktree', () => {
    expect(decide('/work/a', [...twoWorktrees, pane(C, WT_A)])).toEqual({ kind: 'keep' })
  })

  describe('after a restart, before panes re-register their keys', () => {
    const unkeyed = [pane(null, WT_A, false), pane(null, WT_B, false)]

    it('keeps the daemon starter session in its own worktree', () => {
      expect(decide('/work/a', unkeyed)).toEqual({ kind: 'keep' })
    })

    it('drops a session from another worktree instead of filing it on the starter', () => {
      expect(decide('/work/b', unkeyed)).toEqual({ kind: 'drop' })
    })
  })

  it('matches a folder workspace by its directory', () => {
    const folder = 'folder-repo::/work/notes::workspace:12345678-1234-4234-8234-123456789012'
    expect(decide('/work/notes', [pane(A, WT_A), pane(B, folder)])).toEqual({
      kind: 'rebind',
      paneKey: B,
      worktreeId: folder
    })
  })

  it('matches a WSL pane worktree against the Linux cwd Codex reports', () => {
    const wsl = 'repo::\\\\wsl.localhost\\Ubuntu\\home\\me\\proj'
    expect(decide('/home/me/proj', [pane(A, WT_A), pane(B, wsl)])).toEqual({
      kind: 'rebind',
      paneKey: B,
      worktreeId: wsl
    })
  })

  it('keeps the stamp when the payload has no cwd', () => {
    expect(decide(undefined, twoWorktrees)).toEqual({ kind: 'keep' })
  })

  it('without a pane inventory, keeps or drops by the stamped worktree alone', () => {
    expect(decide('/work/a/x', null)).toEqual({ kind: 'keep' })
    expect(decide('/work/b', null)).toEqual({ kind: 'drop' })
  })
})

describe('attributeCodexSharedDaemonHookBody', () => {
  const body = {
    paneKey: A,
    tabId: 'tab-a',
    worktreeId: WT_A,
    launchToken: 'starter-token',
    executor: 'codex-shared-daemon',
    payload: JSON.stringify({ cwd: '/work/b', session_id: 's' })
  }
  const panes = [pane(A, WT_A), pane(B, WT_B)]

  it('rewrites the stamp to the owning pane with that pane token', () => {
    expect(attributeCodexSharedDaemonHookBody(body, panes, () => 'b-token')).toMatchObject({
      paneKey: B,
      tabId: 'tab-b',
      worktreeId: WT_B,
      launchToken: 'b-token'
    })
  })

  it('leaves bodies without the daemon marker untouched', () => {
    const plain = { ...body, executor: undefined }
    expect(attributeCodexSharedDaemonHookBody(plain, panes, () => 'b-token')).toBe(plain)
  })

  it('blanks the pane key of an unattributable post', () => {
    const tied = [...panes, pane(C, WT_B)]
    expect(attributeCodexSharedDaemonHookBody(body, tied, () => undefined)).toMatchObject({
      paneKey: ''
    })
  })
})

describe('mergeRelayAgentHookRequest', () => {
  const headers = {
    'x-orca-agent-hook-meta-encoding': 'base64',
    'x-orca-agent-hook-meta': Buffer.from(
      [A, 'tab-a', '', WT_A, 'production', '1'].join('\x1f')
    ).toString('base64'),
    'x-orca-agent-hook-executor': 'codex-shared-daemon'
  }

  it('drops a daemon post whose session runs in another worktree', () => {
    expect(mergeRelayAgentHookRequest({ cwd: '/work/b' }, headers)).toMatchObject({ paneKey: '' })
  })

  it('keeps a daemon post whose session runs in the stamped worktree', () => {
    expect(mergeRelayAgentHookRequest({ cwd: '/work/a' }, headers)).toMatchObject({
      paneKey: A,
      worktreeId: WT_A
    })
  })
})
