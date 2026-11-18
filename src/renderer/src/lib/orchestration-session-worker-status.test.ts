import { describe, expect, it } from 'vitest'
import { sessionWorkerLook, sessionWorkerRestingLabel } from './orchestration-session-worker-status'

describe('sessionWorkerLook', () => {
  it('draws only a worker whose agent is mid-turn as working', () => {
    const claude = { state: 'working', activity: 'working' } as const
    // Its turn ended waiting on its coordinator; its Dispatch and process stay open.
    const codex = { state: 'working', activity: 'done' } as const

    expect(sessionWorkerLook(claude)).toMatchObject({ status: 'working', group: 'working' })
    expect(sessionWorkerLook(codex)).toMatchObject({ status: 'done', group: 'idle' })
  })

  it('draws an agent waiting on input as needing you', () => {
    expect(sessionWorkerLook({ state: 'working', activity: 'waiting' })).toEqual({
      status: 'permission',
      group: 'needsYou',
      asksCoordinator: false
    })
  })

  it('rests an open ask on its coordinator, named in its label, never needing you', () => {
    const asks = sessionWorkerLook({ state: 'working', activity: 'working', pendingQuestion: true })
    expect(asks).toEqual({ status: 'done', group: 'idle', asksCoordinator: true })
    expect(sessionWorkerRestingLabel(asks, 'Bot builder')).toBe('Asked Bot builder a question')
  })

  it('shows a prompt the agent reports over its open ask', () => {
    const blocked = { state: 'working', activity: 'blocked', pendingQuestion: true } as const
    expect(sessionWorkerLook(blocked)).toEqual({
      status: 'permission',
      group: 'needsYou',
      asksCoordinator: false
    })
  })

  it('keeps an older host, which reports no activity, working while open', () => {
    expect(sessionWorkerLook({ state: 'working' }).group).toBe('working')
  })
})
