import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { MantisBTIssue } from '../../../../shared/mantisbt-types'
import { createMantisBTSlice } from './mantisbt'
import { clearMantisBTInflightRequests } from './mantisbt-read-coordination'

const mantisBTListIssues = vi.fn()

vi.mock('@/runtime/runtime-mantisbt-client', () => ({
  mantisBTListIssues: (...args: unknown[]) => mantisBTListIssues(...args)
}))

type ProgressEvent = { requestId: string; issues: MantisBTIssue[] }

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test store wires only the MantisBT slice, not every AppState slice; mirrors mantisbt.test.ts.
      ({
        settings: null,
        ...createMantisBTSlice(...a)
      }) as AppState
  )
}

function issue(id: string): MantisBTIssue {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listeners only forward the array; no field beyond id is read.
  return { id } as MantisBTIssue
}

describe('listMantisBTIssues progress', () => {
  afterEach(() => {
    clearMantisBTInflightRequests()
    vi.unstubAllGlobals()
  })

  it('forwards page snapshots to a caller that joins an in-flight request', async () => {
    let emit: ((event: ProgressEvent) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        mantisBT: {
          onListIssuesProgress: (listener: (event: ProgressEvent) => void) => {
            emit = listener
            return () => undefined
          }
        }
      }
    })
    const { promise, resolve } = Promise.withResolvers<MantisBTIssue[]>()
    mantisBTListIssues.mockReturnValue(promise)
    const store = createTestStore()

    // The original caller has no progress listener; the joiner arrives after page 1.
    const first = store.getState().listMantisBTIssues('all', 30, { siteId: 'site-1' })
    const requestId = String(mantisBTListIssues.mock.calls[0]?.[5])
    emit?.({ requestId, issues: [issue('1')] })
    const joinerProgress: string[][] = []
    const joined = store.getState().listMantisBTIssues('all', 30, {
      siteId: 'site-1',
      onProgress: (issues) => joinerProgress.push(issues.map((entry) => entry.id))
    })
    emit?.({ requestId, issues: [issue('1'), issue('2')] })
    resolve([issue('1'), issue('2')])
    await Promise.all([first, joined])

    expect(mantisBTListIssues).toHaveBeenCalledTimes(1)
    expect(joinerProgress).toEqual([['1'], ['1', '2']])
  })
})
