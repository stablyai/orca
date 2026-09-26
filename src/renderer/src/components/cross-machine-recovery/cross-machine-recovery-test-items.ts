import type { CcSyncItem } from '../../../../shared/cross-machine-recovery-provider-types'

type SessionInput = { id: string; title?: string; human: string | null; collision?: boolean }

export function recoveryTestItem(input: {
  host: string
  reachable?: boolean
  workspace: string
  ready?: boolean
  missing?: string[]
  sessions: SessionInput[]
}): CcSyncItem {
  return {
    selector: `${input.host}/${input.workspace}`,
    source: {
      host_id: input.host,
      host_name: `${input.host}-name`,
      last_seen_at: null,
      reachable: input.reachable ?? true
    },
    workspace: {
      id: input.workspace,
      repo_name: 'orca',
      repo_origin: null,
      branch: 'main',
      source_path: '/src',
      orca: { kind: 'worktree', name: `${input.workspace}-name`, instance_id: 'i' }
    },
    sessions: input.sessions.map((session) => ({
      session_id: session.id,
      title: session.title ?? session.id,
      last_activity_at: session.human,
      last_human_activity_at: session.human,
      activity: 'human',
      bound_in_orca: true,
      live_local_collision: session.collision ?? false
    })),
    checkpoint: {
      id: 'c',
      tier: 'latest',
      captured_at: '2026-09-26T00:00:00Z',
      source_activity_at: null
    },
    checkpoint_count: 1,
    completeness: {
      ready: input.ready ?? true,
      missing: input.missing ?? [],
      transcript: 'complete',
      code: 'complete',
      layout: 'client-view'
    },
    pause: null,
    local_checkout: null
  }
}
