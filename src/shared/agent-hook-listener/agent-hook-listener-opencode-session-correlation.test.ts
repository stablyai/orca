import { describe, expect, it } from 'vitest'
import { correlateOpenCodeSessionOwners } from './opencode-session-correlation'

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

describe('correlateOpenCodeSessionOwners', () => {
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
})
