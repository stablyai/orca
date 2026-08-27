import { describe, expect, it } from 'vitest'
import type { KanbanMarkStartedArgs, KanbanMarkStartedResult } from './kanban-types'

function summarize(result: KanbanMarkStartedResult): {
  ok: boolean
  retry: 'all' | 'comment-only' | null
  moved: boolean
  commented: boolean
} {
  if (result.ok) {
    return { ok: true, retry: null, moved: result.moved, commented: result.commented }
  }
  return { ok: false, retry: result.retry, moved: result.moved, commented: result.commented }
}

describe('Kanban mark-started wire contract', () => {
  it('accepts a comment-only retry marker and a null branch in the argument shape', () => {
    const args: KanbanMarkStartedArgs = {
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: null,
      retry: 'comment-only'
    }
    expect(args.branch).toBeNull()
    expect(args.retry).toBe('comment-only')
  })

  it('defaults retry to the full attempt when a consumer omits it', () => {
    const args: KanbanMarkStartedArgs = {
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: 'feature-x'
    }
    expect(args.retry ?? 'all').toBe('all')
  })

  it('narrows the ok variant to moved and commented flags', () => {
    const result: KanbanMarkStartedResult = { ok: true, moved: true, commented: true }
    expect(summarize(result)).toEqual({ ok: true, retry: null, moved: true, commented: true })
  })

  it('keeps the retry mode on the failure variant so a partial success resumes comment-only', () => {
    const result: KanbanMarkStartedResult = {
      ok: false,
      moved: true,
      commented: false,
      retry: 'comment-only',
      code: 'server',
      message: 'Comment failed'
    }
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retry).toBe('comment-only')
      expect(result.code).toBe('server')
    }
  })

  it('constrains the failure code to the documented union', () => {
    const result: KanbanMarkStartedResult = {
      ok: false,
      moved: false,
      commented: false,
      retry: 'all',
      code: 'conflict',
      message: 'Stale version'
    }
    if (!result.ok) {
      expect(['unauthorized', 'network', 'conflict', 'invalid_response', 'server']).toContain(
        result.code
      )
    }
  })
})