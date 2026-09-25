import { describe, expect, it } from 'vitest'
import {
  correlateOpenCodeSessionOwners,
  sessionIdFromArgv
} from './agent-hook-listener/opencode-session-correlation'

const NOW = 1_000_000_000
const DIR = '/Users/jin/work/mocitec'

function session(id: string, createdAtMs: number, parentId: string | null = null) {
  return { id, directory: DIR, createdAtMs, parentId }
}

function client(
  paneKey: string,
  startedAtMs: number,
  lastSeenAliveMs = NOW,
  argv: readonly string[] = ['opencode']
) {
  return { paneKey, startedAtMs, lastSeenAliveMs, argv }
}

describe('sessionIdFromArgv', () => {
  it('reads --session forms', () => {
    expect(sessionIdFromArgv(['opencode', '--session', 'ses_1'])).toBe('ses_1')
    expect(sessionIdFromArgv(['opencode', '-s', 'ses_2'])).toBe('ses_2')
    expect(sessionIdFromArgv(['opencode', '--session=ses_3'])).toBe('ses_3')
  })

  it('ignores bare launches and flag-like values', () => {
    expect(sessionIdFromArgv(['opencode'])).toBeNull()
    expect(sessionIdFromArgv(['opencode', '--session'])).toBeNull()
    expect(sessionIdFromArgv(['opencode', '--session', '--port'])).toBeNull()
  })
})

describe('correlateOpenCodeSessionOwners', () => {
  it('binds a lone pane in the directory', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [{ paneKey: 'pane-a', directory: DIR }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-a', basis: 'single-pane-directory' }
    ])
  })

  it('contains sessions beneath the worktree root', () => {
    const sub = correlateOpenCodeSessionOwners({
      sessions: [
        {
          id: 'ses_sub',
          directory: `${DIR}/packages/app`,
          createdAtMs: NOW - 60_000,
          parentId: null
        }
      ],
      panes: [{ paneKey: 'pane-a', directory: DIR }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(sub).toEqual([
      { sessionId: 'ses_sub', paneKey: 'pane-a', basis: 'single-pane-directory' }
    ])
  })

  it('strips the macOS /tmp alias so both spellings meet', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [
        { id: 'ses_1', directory: '/tmp/binder-e2e', createdAtMs: NOW - 60_000, parentId: null }
      ],
      panes: [{ paneKey: 'pane-a', directory: '/private/tmp/binder-e2e' }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-a', basis: 'single-pane-directory' }
    ])
  })

  it('keeps genuinely distinct /private roots apart', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [
        { id: 'ses_1', directory: '/private/repo', createdAtMs: NOW - 60_000, parentId: null }
      ],
      panes: [{ paneKey: 'pane-a', directory: '/repo' }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('folds Windows case differences', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [
        { id: 'ses_1', directory: 'c:\\users\\repo', createdAtMs: NOW - 60_000, parentId: null }
      ],
      panes: [{ paneKey: 'pane-a', directory: 'C:\\Users\\Repo' }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-a', basis: 'single-pane-directory' }
    ])
  })

  it('keeps POSIX backslashes literal', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [
        { id: 'ses_1', directory: '/repo/a\\b', createdAtMs: NOW - 60_000, parentId: null }
      ],
      panes: [{ paneKey: 'pane-a', directory: '/repo/a/b' }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('resolves dot segments before containment', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [
        { id: 'ses_1', directory: '/repo/../other', createdAtMs: NOW - 60_000, parentId: null }
      ],
      panes: [{ paneKey: 'pane-a', directory: '/repo' }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('leaves a session unbound when no client brackets it', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [{ paneKey: 'pane-a', directory: DIR }],
      clients: [],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('breaks a same-directory tie by client evidence', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR },
        { paneKey: 'pane-b', directory: DIR }
      ],
      clients: [client('pane-b', NOW - 120_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-b', basis: 'creation-correlation' }
    ])
  })

  it('stays unbound when both same-directory panes evidence a client', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR },
        { paneKey: 'pane-b', directory: DIR }
      ],
      clients: [client('pane-a', NOW - 120_000), client('pane-b', NOW - 90_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('breaks a same-directory tie with the pane typed into just before creation', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR, lastInputAtMs: NOW - 3_600_000 },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 65_000 }
      ],
      clients: [client('pane-a', NOW - 86_400_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-b', basis: 'creation-correlation' }
    ])
  })

  it('prefers whichever of two in-window panes was typed into last', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR, lastInputAtMs: NOW - 90_000 },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 65_000 }
      ],
      clients: [client('pane-a', NOW - 86_400_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-b', basis: 'creation-correlation' }
    ])
  })

  it('binds the only typed pane even when the other has no input record', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 65_000 }
      ],
      clients: [client('pane-a', NOW - 86_400_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-b', basis: 'creation-correlation' }
    ])
  })

  it('stays unbound when both panes were typed into before creation', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR, lastInputAtMs: NOW - 65_000 },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 65_000 }
      ],
      clients: [client('pane-a', NOW - 86_400_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('ignores input older than the tie-break window', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR, lastInputAtMs: NOW - 600_000 },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 660_000 }
      ],
      clients: [client('pane-a', NOW - 86_400_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('abstains when a pane was typed into after the session was created', () => {
    // lastInputAtMs holds only the newest write, so pane-b's pre-creation
    // evidence has been overwritten by later typing. Skipping it would let
    // pane-a win as the unique in-window leader and reproduce #22838.
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR, lastInputAtMs: NOW - 65_000 },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 10_000 }
      ],
      clients: [client('pane-a', NOW - 86_400_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('binds an Orca-launched session to the pane whose client just booted', () => {
    // Orca passes the first prompt with --prompt, so the creating pane writes
    // nothing and input alone would hand the session to the bystander in
    // pane-b, which was typed into a second before creation.
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 61_000 }
      ],
      clients: [client('pane-a', NOW - 65_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-a', basis: 'creation-correlation' }
    ])
  })

  it('stays unbound when two panes booted together', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR },
        { paneKey: 'pane-b', directory: DIR }
      ],
      clients: [client('pane-a', NOW - 65_000), client('pane-b', NOW - 65_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('ignores a client that started after the session was created', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 65_000 }
      ],
      clients: [client('pane-a', NOW - 40_000), client('pane-b', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-b', basis: 'creation-correlation' }
    ])
  })

  it('ignores input when only one pane has client evidence', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR, lastInputAtMs: NOW - 65_000 },
        { paneKey: 'pane-b', directory: DIR, lastInputAtMs: NOW - 61_000 }
      ],
      clients: [client('pane-a', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toEqual([
      { sessionId: 'ses_1', paneKey: 'pane-a', basis: 'creation-correlation' }
    ])
  })

  it('rejects a client that started after creation beyond skew', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 3_600_000)],
      panes: [{ paneKey: 'pane-a', directory: DIR }],
      clients: [client('pane-a', NOW - 60_000, NOW)],
      knownOwners: new Map()
    })
    expect(results).toEqual([])
  })

  it('accepts a long-lived client that brackets creation', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [{ paneKey: 'pane-a', directory: DIR }],
      clients: [client('pane-a', NOW - 86_400_000)],
      knownOwners: new Map()
    })
    expect(results).toHaveLength(1)
  })

  it('binds by argv even in a crowded directory', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_9', NOW - 60_000)],
      panes: [
        { paneKey: 'pane-a', directory: DIR },
        { paneKey: 'pane-b', directory: DIR }
      ],
      clients: [
        client('pane-a', NOW - 120_000),
        client('pane-b', NOW - 110_000, NOW, ['opencode', '--session', 'ses_9'])
      ],
      knownOwners: new Map()
    })
    expect(results).toEqual([{ sessionId: 'ses_9', paneKey: 'pane-b', basis: 'argv' }])
  })

  it('a child session inherits its bound root', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_child', NOW - 30_000, 'ses_root')],
      panes: [{ paneKey: 'pane-a', directory: DIR }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map([['ses_root', 'pane-a']])
    })
    expect(results).toEqual([
      { sessionId: 'ses_child', paneKey: 'pane-a', basis: 'creation-correlation' }
    ])
  })

  it('skips already-known sessions', () => {
    const results = correlateOpenCodeSessionOwners({
      sessions: [session('ses_1', NOW - 60_000)],
      panes: [{ paneKey: 'pane-a', directory: DIR }],
      clients: [client('pane-a', NOW - 120_000)],
      knownOwners: new Map([['ses_1', 'pane-a']])
    })
    expect(results).toEqual([])
  })
})
