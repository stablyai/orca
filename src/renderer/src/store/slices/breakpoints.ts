import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Breakpoint } from '../../../../shared/debug-breakpoint-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { readDebugBreakpoints, writeDebugBreakpoints } from '@/lib/debug-breakpoint-storage'

export type BreakpointDraft = Pick<Breakpoint, 'condition' | 'hitCondition' | 'logMessage'>

export type BreakpointsSlice = {
  breakpointsByPath: Record<string, Breakpoint[]>
  getBreakpointsForPath: (path: string) => Breakpoint[]
  /** Adds a plain breakpoint at `line`, or removes whatever breakpoint (plain, conditional, or logpoint) already sits there. */
  toggleLineBreakpoint: (path: string, line: number) => void
  /** Adds a breakpoint at `line` with the given condition/hit-count/log-message, or updates it if one already exists there. */
  upsertLineBreakpoint: (path: string, line: number, draft: BreakpointDraft) => void
  removeBreakpoint: (path: string, id: string) => void
}

// Why: a stable shared sentinel avoids selector re-renders/allocations for files with no breakpoints.
const EMPTY_BREAKPOINTS: readonly Breakpoint[] = Object.freeze([])

function isBlankDraft(draft: BreakpointDraft): boolean {
  return !draft.condition && !draft.hitCondition && !draft.logMessage
}

function persist(breakpointsByPath: Record<string, Breakpoint[]>): void {
  writeDebugBreakpoints(breakpointsByPath)
}

// Why: drop the path key entirely once its list is empty so state and storage don't accumulate `path: []` cruft as breakpoints toggle on/off.
function withPathBreakpoints(
  breakpointsByPath: Record<string, Breakpoint[]>,
  path: string,
  next: Breakpoint[]
): Record<string, Breakpoint[]> {
  const updated = { ...breakpointsByPath }
  if (next.length === 0) {
    delete updated[path]
  } else {
    updated[path] = next
  }
  return updated
}

export const createBreakpointsSlice: StateCreator<AppState, [], [], BreakpointsSlice> = (
  set,
  get
) => ({
  breakpointsByPath: readDebugBreakpoints(),

  getBreakpointsForPath: (path) => {
    return get().breakpointsByPath[path] ?? (EMPTY_BREAKPOINTS as Breakpoint[])
  },

  toggleLineBreakpoint: (path, line) => {
    set((state) => {
      const existing = state.breakpointsByPath[path] ?? []
      const withoutLine = existing.filter((bp) => bp.line !== line)
      const next =
        withoutLine.length === existing.length
          ? [
              ...existing,
              { id: createBrowserUuid(), path, line, verified: false } satisfies Breakpoint
            ]
          : withoutLine
      const breakpointsByPath = withPathBreakpoints(state.breakpointsByPath, path, next)
      persist(breakpointsByPath)
      return { breakpointsByPath }
    })
  },

  upsertLineBreakpoint: (path, line, draft) => {
    set((state) => {
      const existing = state.breakpointsByPath[path] ?? []
      const idx = existing.findIndex((bp) => bp.line === line)
      let next: Breakpoint[]
      if (idx === -1) {
        if (isBlankDraft(draft)) {
          return {}
        }
        next = [
          ...existing,
          { id: createBrowserUuid(), path, line, verified: false, ...draft } satisfies Breakpoint
        ]
      } else {
        const updated: Breakpoint = { ...existing[idx], ...draft }
        next = existing.map((bp, i) => (i === idx ? updated : bp))
      }
      const breakpointsByPath = withPathBreakpoints(state.breakpointsByPath, path, next)
      persist(breakpointsByPath)
      return { breakpointsByPath }
    })
  },

  removeBreakpoint: (path, id) => {
    set((state) => {
      const existing = state.breakpointsByPath[path]
      if (!existing) {
        return {}
      }
      const next = existing.filter((bp) => bp.id !== id)
      if (next.length === existing.length) {
        return {}
      }
      const breakpointsByPath = withPathBreakpoints(state.breakpointsByPath, path, next)
      persist(breakpointsByPath)
      return { breakpointsByPath }
    })
  }
})
