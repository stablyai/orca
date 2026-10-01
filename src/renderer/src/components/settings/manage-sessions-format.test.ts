import { describe, expect, it } from 'vitest'
import type { PtyManagementGeneration, PtyManagementSession } from '../../../../preload/api-types'
import {
  formatState,
  formatVisibleSessionCount,
  generationSessionCount,
  visibleGenerations
} from './manage-sessions-format'

function makeSession(overrides: Partial<PtyManagementSession> = {}): PtyManagementSession {
  return {
    sessionId: 'w@@1',
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 100,
    cwd: '/repo/worktree',
    cols: 80,
    rows: 24,
    createdAt: 0,
    protocolVersion: 36,
    backsTab: true,
    ...overrides
  }
}

describe('manage-sessions-format', () => {
  describe('generation legibility', () => {
    it('reads an unreachable generation as unverifiable, not as a zero count', () => {
      const unreachable: PtyManagementGeneration = {
        protocolVersion: 35,
        isCurrent: false,
        contact: 'unverifiable',
        reason: 'listing-failed',
        detail: 'legacy socket dead'
      }

      expect(generationSessionCount(unreachable)).toBeNull()
    })

    it('counts a reachable generation exactly, including a genuinely empty one', () => {
      const live: PtyManagementGeneration = {
        protocolVersion: 36,
        isCurrent: true,
        contact: 'live',
        sessions: [makeSession()]
      }
      const empty: PtyManagementGeneration = {
        protocolVersion: 34,
        isCurrent: false,
        contact: 'live',
        sessions: []
      }

      expect(generationSessionCount(live)).toBe(1)
      expect(generationSessionCount(empty)).toBe(0)
    })

    it('hides a previous version with nothing to act on, and keeps the current one', () => {
      const current: PtyManagementGeneration = {
        protocolVersion: 36,
        isCurrent: true,
        contact: 'live',
        sessions: []
      }
      const exited: PtyManagementGeneration = {
        protocolVersion: 35,
        isCurrent: false,
        contact: 'exited'
      }
      const emptied: PtyManagementGeneration = {
        protocolVersion: 34,
        isCurrent: false,
        contact: 'live',
        sessions: []
      }
      const silent: PtyManagementGeneration = {
        protocolVersion: 33,
        isCurrent: false,
        contact: 'unverifiable',
        reason: 'listing-failed',
        detail: null
      }
      const holding: PtyManagementGeneration = {
        protocolVersion: 32,
        isCurrent: false,
        contact: 'live',
        sessions: [makeSession()]
      }

      expect(
        visibleGenerations([current, exited, emptied, silent, holding]).map(
          (g) => g.protocolVersion
        )
      ).toEqual([36, 33, 32])
    })

    it('marks the total as a lower bound while any generation is unverifiable', () => {
      const live: PtyManagementGeneration = {
        protocolVersion: 36,
        isCurrent: true,
        contact: 'live',
        sessions: [makeSession(), makeSession({ sessionId: 'w@@2' })]
      }
      const unreachable: PtyManagementGeneration = {
        protocolVersion: 35,
        isCurrent: false,
        contact: 'unverifiable',
        reason: 'listing-failed',
        detail: null
      }

      expect(formatVisibleSessionCount([live])).toBe('2')
      expect(formatVisibleSessionCount([live, unreachable])).toBe('2+')
      expect(formatVisibleSessionCount([unreachable])).toBeNull()
    })
  })

  describe('formatState', () => {
    // The daemon's own producer hard-codes `isAlive: true` and drops every
    // non-alive session before it leaves the host, so a client-side
    // `!isAlive -> exited` branch could only ever assert absence it never observed.
    it('does not derive an exited verdict from client-side isAlive bookkeeping', () => {
      expect(formatState(makeSession({ isAlive: false, shellState: 'ready' }))).toBe('running')
      expect(formatState(makeSession({ isAlive: false, shellState: 'pending' }))).toBe('starting')
    })

    it('passes the host-reported state through when the shell state is not decisive', () => {
      expect(formatState(makeSession({ shellState: 'timed_out', state: 'exited' }))).toBe('exited')
      expect(formatState(makeSession({ shellState: 'unsupported', state: 'running' }))).toBe(
        'running'
      )
    })
  })
})
