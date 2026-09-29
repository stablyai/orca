import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentMainAgentStatus } from '../../../../shared/main-agent-status'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'

const PANE_KEY = 'tab-1:leaf-1'

function row(state: AgentStatusEntry['state'], mainAgent?: AgentMainAgentStatus) {
  const entry: AgentStatusEntry = {
    paneKey: PANE_KEY,
    state,
    prompt: 'do the thing',
    updatedAt: 2_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    ...(mainAgent ? { mainAgent } : {})
  }
  return { paneKey: PANE_KEY, entry, state, startedAt: 1_000 }
}

describe('dashboardRowBucketProjection', () => {
  it('files a failed main agent under Done with its verdict while subagents work', () => {
    const projected = dashboardRowBucketProjection(
      row('working', { state: 'done', outcome: 'failure', stateStartedAt: 1_500 })
    )
    expect(projected).toMatchObject({ dotState: 'working', verdictMark: 'failed', bucket: 'done' })
  })

  it('files an unseen verdict under Done', () => {
    for (const outcome of ['failure', 'cancellation'] as const) {
      const projected = dashboardRowBucketProjection(
        row('done', { state: 'done', outcome, stateStartedAt: 1_000 })
      )
      expect(projected).toMatchObject({ unseen: true, bucket: 'done' })
    }
  })

  it('settles a seen verdict into Idle like a seen completion, keeping its mark', () => {
    const stopped = dashboardRowBucketProjection(
      row('done', { state: 'done', outcome: 'cancellation', stateStartedAt: 1_000 }),
      { [PANE_KEY]: 5_000 }
    )
    expect(stopped).toMatchObject({ unseen: false, verdictMark: 'interrupted', bucket: 'idle' })
    const failed = dashboardRowBucketProjection(
      row('done', { state: 'done', outcome: 'failure', stateStartedAt: 1_000 }),
      { [PANE_KEY]: 5_000 }
    )
    expect(failed).toMatchObject({ unseen: false, verdictMark: 'failed', bucket: 'idle' })
  })

  it('keeps a seen failure under Done while its subagents still work', () => {
    const projected = dashboardRowBucketProjection(
      row('working', { state: 'done', outcome: 'failure', stateStartedAt: 1_500 }),
      { [PANE_KEY]: 5_000 }
    )
    expect(projected).toMatchObject({ unseen: false, verdictMark: 'failed', bucket: 'done' })
  })

  it("files a failed main agent under Needs you while a subagent's question is pending", () => {
    const projected = dashboardRowBucketProjection(
      row('waiting', { state: 'done', outcome: 'failure', stateStartedAt: 1_500 }),
      { [PANE_KEY]: 5_000 }
    )
    expect(projected).toMatchObject({ verdictMark: 'failed', bucket: 'attention' })
  })

  it('files a failure whose subagents went silent like a completion', () => {
    const failed = { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: 1_500 }
    const decayed = { ...row('working', failed), state: 'idle' as const }
    expect(dashboardRowBucketProjection(decayed)).toMatchObject({ bucket: 'done' })
    expect(dashboardRowBucketProjection(decayed, { [PANE_KEY]: 5_000 })).toMatchObject({
      verdictMark: 'failed',
      bucket: 'idle'
    })
  })

  it('projects a row without a verdict exactly as before', () => {
    const projected = dashboardRowBucketProjection(row('done'), { [PANE_KEY]: 5_000 })
    expect(projected).toMatchObject({ verdictMark: undefined, bucket: 'idle' })
  })
})
