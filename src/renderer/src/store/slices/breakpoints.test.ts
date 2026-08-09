import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'

const { readDebugBreakpoints, writeDebugBreakpoints } = vi.hoisted(() => ({
  readDebugBreakpoints: vi.fn(() => ({})),
  writeDebugBreakpoints: vi.fn()
}))

vi.mock('@/lib/debug-breakpoint-storage', () => ({ readDebugBreakpoints, writeDebugBreakpoints }))

import { createBreakpointsSlice } from './breakpoints'

type SliceState = Pick<
  AppState,
  | 'breakpointsByPath'
  | 'getBreakpointsForPath'
  | 'toggleLineBreakpoint'
  | 'upsertLineBreakpoint'
  | 'removeBreakpoint'
>

function makeStore() {
  return create<SliceState>()((...args) =>
    createBreakpointsSlice(...(args as Parameters<typeof createBreakpointsSlice>))
  )
}

afterEach(() => {
  vi.clearAllMocks()
  readDebugBreakpoints.mockReturnValue({})
})

describe('createBreakpointsSlice', () => {
  it('seeds state from storage on creation', () => {
    readDebugBreakpoints.mockReturnValueOnce({
      '/a.ts': [{ id: '1', path: '/a.ts', line: 5, verified: true }]
    })
    const store = makeStore()
    expect(store.getState().getBreakpointsForPath('/a.ts')).toEqual([
      { id: '1', path: '/a.ts', line: 5, verified: true }
    ])
  })

  it('returns the same empty array reference for a path with no breakpoints', () => {
    const store = makeStore()
    const a = store.getState().getBreakpointsForPath('/none.ts')
    const b = store.getState().getBreakpointsForPath('/none.ts')
    expect(a).toBe(b)
    expect(a).toEqual([])
  })

  it('toggles a plain breakpoint on then off, persisting each change', () => {
    const store = makeStore()

    store.getState().toggleLineBreakpoint('/a.ts', 10)
    const [bp] = store.getState().getBreakpointsForPath('/a.ts')
    expect(bp).toMatchObject({ path: '/a.ts', line: 10, verified: false })
    expect(bp.id).toEqual(expect.any(String))
    expect(writeDebugBreakpoints).toHaveBeenCalledWith({ '/a.ts': [bp] })

    store.getState().toggleLineBreakpoint('/a.ts', 10)
    expect(store.getState().getBreakpointsForPath('/a.ts')).toEqual([])
    expect(writeDebugBreakpoints).toHaveBeenLastCalledWith({})
  })

  it('toggle removes a conditional breakpoint at that line entirely', () => {
    const store = makeStore()
    store.getState().upsertLineBreakpoint('/a.ts', 10, { condition: 'x > 1' })

    store.getState().toggleLineBreakpoint('/a.ts', 10)

    expect(store.getState().getBreakpointsForPath('/a.ts')).toEqual([])
  })

  it('upsert adds a new breakpoint with the given draft fields', () => {
    const store = makeStore()
    store.getState().upsertLineBreakpoint('/a.ts', 4, { condition: 'i === 10' })

    expect(store.getState().getBreakpointsForPath('/a.ts')).toMatchObject([
      { line: 4, condition: 'i === 10', verified: false }
    ])
  })

  it('upsert is a no-op for a blank draft with no existing breakpoint', () => {
    const store = makeStore()
    store.getState().upsertLineBreakpoint('/a.ts', 4, {})

    expect(store.getState().getBreakpointsForPath('/a.ts')).toEqual([])
    expect(writeDebugBreakpoints).not.toHaveBeenCalled()
  })

  it('upsert updates an existing breakpoint in place, preserving its id', () => {
    const store = makeStore()
    store.getState().toggleLineBreakpoint('/a.ts', 4)
    const [{ id }] = store.getState().getBreakpointsForPath('/a.ts')

    store.getState().upsertLineBreakpoint('/a.ts', 4, { logMessage: 'hit {n}' })

    expect(store.getState().getBreakpointsForPath('/a.ts')).toEqual([
      { id, path: '/a.ts', line: 4, verified: false, logMessage: 'hit {n}' }
    ])
  })

  it('removeBreakpoint drops the path entry once empty', () => {
    const store = makeStore()
    store.getState().toggleLineBreakpoint('/a.ts', 4)
    const [{ id }] = store.getState().getBreakpointsForPath('/a.ts')

    store.getState().removeBreakpoint('/a.ts', id)

    expect(store.getState().breakpointsByPath).not.toHaveProperty('/a.ts')
    expect(writeDebugBreakpoints).toHaveBeenLastCalledWith({})
  })

  it('removeBreakpoint is a no-op for an unknown id', () => {
    const store = makeStore()
    store.getState().toggleLineBreakpoint('/a.ts', 4)
    vi.clearAllMocks()

    store.getState().removeBreakpoint('/a.ts', 'missing')

    expect(writeDebugBreakpoints).not.toHaveBeenCalled()
  })
})
