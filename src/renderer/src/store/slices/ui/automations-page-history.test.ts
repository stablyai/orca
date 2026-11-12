import { describe, expect, it } from 'vitest'
import { useAppStore } from '../../index'
import {
  rewindHistoryIndexPastView,
  type WorktreeNavHistoryEntry
} from './workspace-navigation-history'
import { appendAutomationsPageEntry } from './automations-page-history'
import {
  isAutomationsHistoryEntry,
  automationsPageLocationKey,
  type AutomationsPageLocation
} from './automations-page-location'

const detail: AutomationsPageLocation = { page: 'detail', automationId: 'a1' }
const run: AutomationsPageLocation = {
  page: 'run',
  automationId: 'a1',
  runId: 'r1',
  origin: 'automation'
}
const page = (location: AutomationsPageLocation): WorktreeNavHistoryEntry => ({
  kind: 'automations-page',
  location
})

describe('automations page history', () => {
  it('replaces the plain sentinel that opening the page recorded', () => {
    const next = appendAutomationsPageEntry(
      { worktreeNavHistory: ['skills', 'automations'], worktreeNavHistoryIndex: 1 },
      detail
    )
    expect(next.worktreeNavHistory).toEqual(['skills', page(detail)])
    expect(next.worktreeNavHistoryIndex).toBe(1)
  })

  it('preserves Forward entries when replay replaces a legacy sentinel', () => {
    const next = appendAutomationsPageEntry(
      { worktreeNavHistory: ['skills', 'automations', 'artifacts'], worktreeNavHistoryIndex: 1 },
      { page: 'list' }
    )
    expect(next.worktreeNavHistory).toEqual([
      'skills',
      { kind: 'automations-page', location: { page: 'list' } },
      'artifacts'
    ])
    expect(next.worktreeNavHistoryIndex).toBe(1)
  })

  it('appends each sub-page so Back steps run → detail → list → previous view', () => {
    let s: { worktreeNavHistory: WorktreeNavHistoryEntry[]; worktreeNavHistoryIndex: number } = {
      worktreeNavHistory: ['skills', 'automations'],
      worktreeNavHistoryIndex: 1
    }
    s = appendAutomationsPageEntry(s, { page: 'list' })
    s = appendAutomationsPageEntry(s, detail)
    s = appendAutomationsPageEntry(s, run)
    expect(s.worktreeNavHistory).toEqual([
      'skills',
      page({ page: 'list' }),
      page(detail),
      page(run)
    ])
    expect(s.worktreeNavHistoryIndex).toBe(3)
  })

  it('does not duplicate the current sub-page, whatever the run origin', () => {
    const s: { worktreeNavHistory: WorktreeNavHistoryEntry[]; worktreeNavHistoryIndex: number } = {
      worktreeNavHistory: ['skills', page(run)],
      worktreeNavHistoryIndex: 1
    }
    const next = appendAutomationsPageEntry(s, { ...run, origin: 'runs' })
    expect(next).toBe(s)
  })

  it('keys locations by host so same-id automations on two hosts stay distinct', () => {
    expect(automationsPageLocationKey(detail)).not.toBe(
      automationsPageLocationKey({ ...detail, hostId: 'runtime:env-1' })
    )
  })

  it('closing the page rewinds past every Automations entry', () => {
    const state = {
      ...useAppStore.getInitialState(),
      worktreeNavHistory: ['skills', page({ page: 'list' }), page(detail), page(run)],
      worktreeNavHistoryIndex: 3
    }
    expect(rewindHistoryIndexPastView(state, 'automations')).toBe(0)
  })

  it('treats the sentinel and sub-pages as Automations entries', () => {
    expect(isAutomationsHistoryEntry('automations')).toBe(true)
    expect(isAutomationsHistoryEntry(page(detail))).toBe(true)
    expect(isAutomationsHistoryEntry('skills')).toBe(false)
  })
})
