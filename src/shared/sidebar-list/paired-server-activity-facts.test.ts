import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { buildPairedServerActivityFacts } from './paired-server-activity-facts'
import { normalizePairedServerRow, type PairedServerWorkspaceRow } from './paired-server-rows'
import { composeWorktreeHostIdentity } from '../worktree/host-qualified-identity'

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
  it('keeps a server out of contact unverifiable, never asleep', () => {
    const { facts } = build([serverRow('live', { liveTerminalCount: 1, status: 'active' })], {
      freshness: 'unverifiable'
    })
    expect(facts[composeWorktreeHostIdentity(HOST, 'live')]?.terminal).toBe('unverifiable')
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
    expect(facts[composeWorktreeHostIdentity(HOST, 'browsing')]).toEqual({
      terminal: null,
      browser: true,
      structuredChat: false,
      agent: null
    })
  })

  it('keeps each server’s copy of a same-id workspace under its own key', () => {
    const other = normalizePairedServerRow('runtime:env-2', {
      worktreeId: 'same',
      repoId: 'repo',
      liveTerminalCount: 0,
      status: 'inactive'
    })
    const facts = buildPairedServerActivityFacts(
      [
        { hostId: HOST, freshness: 'live', rows: [serverRow('same', { liveTerminalCount: 1 })] },
        { hostId: 'runtime:env-2', freshness: 'live', rows: other ? [other] : [] }
      ],
      () => null
    )
    expect(Object.keys(facts)).toEqual([`${HOST}|same`])
  })

  it('an older server that sends no counts reports nothing', () => {
    const row = normalizePairedServerRow(HOST, { worktreeId: 'old', repoId: 'repo' })
    expect(row?.activity).toEqual({ terminal: null, agent: null })
  })
})
