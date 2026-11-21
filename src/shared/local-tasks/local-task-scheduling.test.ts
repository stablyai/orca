import { describe, expect, it } from 'vitest'
import { computeLocalTaskReadiness, pickReadyLocalTasks } from './local-task-scheduling'
import type { LocalTask } from './local-task-types'

const task = (id: string, over: Partial<LocalTask> = {}): LocalTask => ({
  id,
  title: id,
  status: 'queued',
  statusCategory: 'todo',
  labels: [],
  url: null,
  dependsOn: [],
  priority: 3,
  claimedBy: null,
  claimedAt: null,
  blockedReason: null,
  updatedAt: '2026-01-01',
  filePath: `/${id}.md`,
  fields: {},
  ...over
})
const done = (id: string, status = 'done'): LocalTask =>
  task(id, { status, statusCategory: 'done' })
const state = (tasks: LocalTask[], id: string, now?: number) =>
  computeLocalTaskReadiness(tasks, { now }).find((r) => r.id === id)

describe('local task readiness', () => {
  it('waits on unfinished dependencies and frees them when done', () => {
    expect(state([task('b', { dependsOn: ['a'] }), task('a')], 'b')).toEqual({
      id: 'b',
      state: 'waiting',
      on: ['a']
    })
    expect(state([task('b', { dependsOn: ['a'] }), done('a')], 'b')?.state).toBe('ready')
  })

  it('flags dropped and missing dependencies instead of unblocking', () => {
    expect(state([task('b', { dependsOn: ['a'] }), done('a', 'dropped')], 'b')?.state).toBe(
      'flagged'
    )
    expect(state([task('b', { dependsOn: ['x'] })], 'b')?.state).toBe('flagged')
  })

  it('skips started, blocked and finished tasks', () => {
    const t = [
      task('w', { status: 'working', statusCategory: 'in-progress' }),
      task('k', { status: 'blocked', statusCategory: 'blocked' }),
      done('d')
    ]
    expect(computeLocalTaskReadiness(t).map((r) => r.state)).toEqual([
      'inactive',
      'inactive',
      'inactive'
    ])
  })

  it('honors a live claim and reclaims an expired lease', () => {
    const claimed = task('a', { claimedBy: 'agent-1', claimedAt: '2026-01-01T00:00:00Z' })
    const at = Date.parse('2026-01-01T00:10:00Z')
    expect(state([claimed], 'a', at)).toEqual({ id: 'a', state: 'claimed', by: 'agent-1' })
    expect(state([claimed], 'a', at + 60 * 60 * 1000)?.state).toBe('ready')
  })

  it('reclaims a working task whose lease expired, but not an unclaimed or fresh one', () => {
    const working = (over: Partial<LocalTask>) =>
      task('a', { status: 'working', statusCategory: 'in-progress', ...over })
    const claim = { claimedBy: 'agent-1', claimedAt: '2026-01-01T00:00:00Z' }
    const at = Date.parse('2026-01-01T00:10:00Z')
    expect(state([working(claim)], 'a', at)).toEqual({ id: 'a', state: 'inactive' })
    expect(state([working(claim)], 'a', at + 60 * 60 * 1000)?.state).toBe('ready')
    expect(state([working({})], 'a', at + 60 * 60 * 1000)?.state).toBe('inactive')
  })

  it('picks by priority then age, within the slot cap', () => {
    const t = [
      task('low', { priority: 4 }),
      task('old', { updatedAt: '2025-01-01' }),
      task('new'),
      task('top', { priority: 1 })
    ]
    expect(pickReadyLocalTasks(t, 3).map((x) => x.id)).toEqual(['top', 'old', 'new'])
    expect(pickReadyLocalTasks(t, 0)).toEqual([])
  })
})
