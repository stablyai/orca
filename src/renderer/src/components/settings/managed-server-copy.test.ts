import { describe, expect, it } from 'vitest'
import { ORCAD_MIGRATION_DEPENDENCY_KINDS } from '../../../../shared/orcad-migration-preflight'
import { conversionBlockerLabel, managedServerOutcomeLabel } from './managed-server-copy'
import { dependencyKindLabel } from './managed-server-dependency-kinds'

describe('managed server blocker copy', () => {
  it('names dependent state in plain words, never the internal kind id', () => {
    expect(
      conversionBlockerLabel({
        code: 'orcad_migration_dependent_state',
        category: 'client-owned-state',
        dependencies: [{ kind: 'workspace-session', count: 1 }]
      })
    ).toBe('State that cannot move yet: open tabs and layout (1).')
    expect(
      conversionBlockerLabel({
        code: 'orcad_migration_dependency_unverifiable',
        category: 'live-or-unverifiable',
        sources: ['automation', 'ui-routing']
      })
    ).toContain('automations, sidebar and filter settings')
  })

  it('has a label for every dependency kind', () => {
    for (const kind of ORCAD_MIGRATION_DEPENDENCY_KINDS) {
      expect(dependencyKindLabel(kind)).not.toBe(kind)
    }
  })
})

describe('managed server action refusals', () => {
  it('explains the active-server guard before interpreting its live verdict as terminals', () => {
    expect(
      managedServerOutcomeLabel({
        outcome: 'refused',
        code: 'orcad_stop_active_environment',
        verdict: 'live'
      })
    ).toBe('Not done: choose another Active Server in Advanced before stopping this server.')
  })

  it.each([
    { outcome: 'refused', code: 'orcad_stop_still_running', verdict: 'live' },
    { outcome: 'deferred', code: 'orcad_update_terminals_running' },
    { outcome: 'refused', code: 'future_terminal_guard', verdict: 'live' }
  ])('keeps the running-terminal instruction for $code', (result) => {
    expect(managedServerOutcomeLabel(result)).toBe(
      'Not done: terminals on this server are still running. Close them and try again.'
    )
  })

  it('keeps an unanswered census unverifiable', () => {
    expect(managedServerOutcomeLabel({ outcome: 'refused', verdict: 'unverifiable' })).toContain(
      'couldn’t confirm what is running'
    )
  })
})
