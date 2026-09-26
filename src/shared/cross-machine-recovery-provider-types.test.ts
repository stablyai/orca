import { describe, expect, it } from 'vitest'
import {
  parseCcSyncInspect,
  parseCcSyncList,
  parseCcSyncPickup,
  parseCcSyncProgressLine,
  parseCcSyncStatus
} from './cross-machine-recovery-provider-types'

const pause = { reason: 'cellular', endpoint: 'local', since: '2026-09-26T10:00:00Z' }

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selector: 'host-a/ws-1',
    source: {
      host_id: 'host-a',
      host_name: 'Laptop',
      last_seen_at: '2026-09-26T10:00:00Z',
      reachable: true
    },
    workspace: {
      id: 'ws-1',
      repo_name: 'monorepo',
      repo_origin: 'git@github.com:acme/monorepo.git',
      branch: 'main',
      source_path: '/Users/me/monorepo',
      orca: { kind: 'worktree', name: 'feature', instance_id: 'inst-1' }
    },
    sessions: [
      {
        session_id: 'sess-1',
        title: 'Fix build',
        last_activity_at: '2026-09-26T10:00:00Z',
        last_human_activity_at: null,
        activity: 'human',
        bound_in_orca: true,
        live_local_collision: false
      }
    ],
    checkpoint: {
      id: 'cp-1',
      tier: 'latest',
      captured_at: '2026-09-26T10:00:00Z',
      source_activity_at: null
    },
    checkpoint_count: 3,
    completeness: {
      ready: false,
      missing: ['lfs:assets/model.bin'],
      transcript: 'complete',
      code: 'deferred',
      layout: 'client-view'
    },
    pause: null,
    local_checkout: null,
    ...overrides
  }
}

describe('cc-sync provider parsers', () => {
  it('parses a status payload', () => {
    const result = parseCcSyncStatus({
      version: 1,
      ok: true,
      helper: { running: true, build: 'v1.2.3' },
      local: {
        host_id: 'host-b',
        host_name: 'Desk',
        network: {
          status: 'online',
          expensive: false,
          constrained: false,
          cellular: false,
          manual_metered: false
        }
      },
      peers: [
        {
          host_id: 'host-a',
          host_name: 'Laptop',
          reachable: false,
          last_seen_at: null,
          acked_revision: 4,
          pending_revision: 6,
          pending_since: '2026-09-26T10:00:00Z',
          pause: { ...pause, reason: 'peer-offline', endpoint: 'peer' }
        }
      ],
      scheduler: {
        queued_by_tier: { human: 1, autonomous: 0, recent: 2, idle: 0 },
        workers: 2,
        last_round_at: null
      }
    })
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.value.peers[0]?.pause).toEqual({
        reason: 'peer-offline',
        endpoint: 'peer',
        since: '2026-09-26T10:00:00Z'
      })
    }
  })

  it('degrades unknown enum arms to unknown instead of rejecting', () => {
    const result = parseCcSyncList({
      version: 1,
      ok: true,
      generated_at: '2026-09-26T10:00:00Z',
      local: { host_id: 'host-b', host_name: 'Desk' },
      items: [
        item({
          pause: { reason: 'satellite', endpoint: 'relay', since: '2026-09-26T10:00:00Z' },
          completeness: {
            ready: true,
            missing: [],
            transcript: 'streaming',
            code: 'partial',
            layout: 'hologram'
          }
        })
      ]
    })
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      const [parsed] = result.value.items
      expect(parsed?.pause).toEqual({
        reason: 'unknown',
        endpoint: 'unknown',
        since: '2026-09-26T10:00:00Z'
      })
      expect(parsed?.completeness).toEqual({
        ready: true,
        missing: [],
        transcript: 'unknown',
        code: 'unknown',
        layout: 'unknown'
      })
    }
  })

  it('rejects a payload missing a required field', () => {
    const { completeness: _completeness, ...withoutCompleteness } = item()
    void _completeness
    const result = parseCcSyncList({
      version: 1,
      ok: true,
      generated_at: '2026-09-26T10:00:00Z',
      local: { host_id: 'host-b', host_name: 'Desk' },
      items: [withoutCompleteness]
    })
    expect(result.kind).toBe('invalid')
  })

  it('rejects an unknown wire version', () => {
    expect(parseCcSyncPickup({ version: 2, ok: true }).kind).toBe('invalid')
  })

  it('surfaces a failure envelope with a known or degraded code', () => {
    expect(
      parseCcSyncPickup({
        version: 1,
        ok: false,
        error: { code: 'not-ready', message: 'checkpoint incomplete' }
      })
    ).toEqual({
      kind: 'failure',
      error: { code: 'not-ready', message: 'checkpoint incomplete' }
    })
    expect(
      parseCcSyncStatus({ version: 1, ok: false, error: { code: 'quota', message: 'x' } })
    ).toEqual({ kind: 'failure', error: { code: 'unknown', message: 'x' } })
  })

  it('parses inspect and pickup payloads', () => {
    const inspect = parseCcSyncInspect({
      version: 1,
      ok: true,
      ...item(),
      checkpoints: [
        {
          id: 'cp-1',
          tier: 'hourly',
          captured_at: '2026-09-26T09:00:00Z',
          ready: true,
          missing: [],
          deferred: []
        }
      ],
      delivery: [{ peer: 'host-b', state: 'acked', pause: null }]
    })
    expect(inspect.kind).toBe('success')
    const pickup = parseCcSyncPickup({
      version: 1,
      ok: true,
      checkout: { path: '/Users/me/monorepo', branch: 'main', reused: true },
      sessions: [{ session_id: 'sess-1', status: 'resumed' }],
      orca: {
        execution_host_id: 'local',
        worktree_id: 'repo::/Users/me/monorepo',
        resumed: [{ session_id: 'sess-1', tab_id: 'tab-1' }],
        dormant: []
      }
    })
    expect(pickup.kind).toBe('success')
  })

  it('reads progress lines and ignores diagnostics', () => {
    expect(parseCcSyncProgressLine('{"phase":"restore-code","done":2,"total":5}')).toEqual({
      phase: 'restore-code',
      done: 2,
      total: 5
    })
    expect(parseCcSyncProgressLine('{"phase":"warp"}')).toEqual({ phase: 'unknown' })
    expect(parseCcSyncProgressLine('warning: slow network')).toBeNull()
  })

  it('keeps divergence details and the refused session status', () => {
    const failure = parseCcSyncPickup({
      version: 1,
      ok: false,
      error: {
        code: 'divergent-local-copy',
        message: 'diverged',
        details: {
          session_id: 's1',
          local_last_activity_at: '2026-09-26T10:00:00Z',
          picked_captured_at: '2026-09-26T09:00:00Z'
        }
      }
    })
    expect(failure).toEqual({
      kind: 'failure',
      error: {
        code: 'divergent-local-copy',
        message: 'diverged',
        details: {
          session_id: 's1',
          local_last_activity_at: '2026-09-26T10:00:00Z',
          picked_captured_at: '2026-09-26T09:00:00Z'
        }
      }
    })
    const odd = parseCcSyncPickup({
      version: 1,
      ok: false,
      error: { code: 'incompatible', message: 'no --resume', details: { flag: 'resume' } }
    })
    expect(odd).toEqual({
      kind: 'failure',
      error: { code: 'incompatible', message: 'no --resume', details: undefined }
    })
    const ok = parseCcSyncPickup({
      version: 1,
      ok: true,
      checkout: { path: '/c', branch: null, reused: false },
      sessions: [{ session_id: 's2', status: 'refused', reason: 'live-local-collision' }],
      orca: null
    })
    expect(ok.kind === 'success' && ok.value.sessions[0]).toEqual({
      session_id: 's2',
      status: 'refused',
      reason: 'live-local-collision'
    })
  })
})
