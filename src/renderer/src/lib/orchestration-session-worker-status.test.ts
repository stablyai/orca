import { describe, expect, it } from 'vitest'
import { sessionWorkerLook } from './orchestration-session-worker-status'

describe('sessionWorkerLook', () => {
  it('rests an open ask on its coordinator without putting it under needs-you', () => {
    const asks = sessionWorkerLook({ state: 'working', activity: 'working', pendingQuestion: true })
    expect(asks).toEqual({ status: 'done', group: 'idle', asksCoordinator: true })
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
