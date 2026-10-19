import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { buildPairedServerActivityFacts } from './paired-server-activity-facts'
import { normalizePairedServerRow, type PairedServerWorkspaceRow } from './paired-server-rows'

const HOST = 'runtime:env-1'

function serverRow(worktreeId: string, fields: Record<string, unknown> = {}) {
  const row = normalizePairedServerRow(HOST, {
    worktreeId,
    repoId: 'repo',
    path: `/srv/${worktreeId}`,
    branch: worktreeId,
    liveTerminalCount: 0,
    status: 'inactive',
    ...fields
  })
  if (!row) {
    throw new Error('row did not normalize')
  }
  return row
}

function build(
  rows: PairedServerWorkspaceRow[],
  options: {
    freshness?: 'live' | 'unverifiable'
    session?: Pick<WorkspaceSessionState, 'browserTabsByWorktree' | 'unifiedTabs'>
  } = {}
) {
  const asked: ExecutionHostId[] = []
  const facts = buildPairedServerActivityFacts(
    [{ hostId: HOST, freshness: options.freshness ?? 'live', rows }],
    (hostId) => {
      asked.push(hostId)
      return options.session ?? null
    }
  )
  return { facts, asked }
}

describe('paired server activity facts', () => {
  it("reads the server's own terminals and agents off its rows", () => {
    const { facts } = build([
      serverRow('live', { liveTerminalCount: 2, status: 'active' }),
      serverRow('lost', { unverifiableTerminalCount: 1 }),
      serverRow('agent', { status: 'working', workingMode: 'monitoring' }),
      serverRow('asks', { liveTerminalCount: 1, status: 'permission' }),
      serverRow('idle', { status: 'done' })
    ])
    expect(facts).toEqual({
      live: { terminal: 'live', browser: false, structuredChat: false, agent: null },
      lost: { terminal: 'unverifiable', browser: false, structuredChat: false, agent: null },
      agent: { terminal: null, browser: false, structuredChat: false, agent: 'monitoring' },
      asks: { terminal: 'live', browser: false, structuredChat: false, agent: 'permission' }
    })
  })

  it('keeps a server out of contact unverifiable, never asleep', () => {
    const { facts } = build([serverRow('live', { liveTerminalCount: 1, status: 'active' })], {
      freshness: 'unverifiable'
    })
    expect(facts.live?.terminal).toBe('unverifiable')
  })

  it("adds the browser tabs this desktop's session holds in a server workspace", () => {
    const { facts, asked } = build([serverRow('browsing')], {
      session: {
        browserTabsByWorktree: {
          browsing: [
            {
              id: 'b1',
              worktreeId: 'browsing',
              url: 'about:blank',
              title: '',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 0
            }
          ]
        },
        unifiedTabs: {}
      }
    })
    expect(asked).toEqual([HOST])
    expect(facts.browsing).toEqual({
      terminal: null,
      browser: true,
      structuredChat: false,
      agent: null
    })
  })

  it('an older server that sends no counts reports nothing', () => {
    const row = normalizePairedServerRow(HOST, { worktreeId: 'old', repoId: 'repo' })
    expect(row?.activity).toEqual({ terminal: null, agent: null })
  })
})
