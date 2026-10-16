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
  it.each([
    ['orcad_update_chat_work_running', 'then choose Update or reconnect to retry'],
    ['orcad_update_chat_work_unverifiable', 'confirm whether chats'],
    ['orcad_update_restart_not_reserved', 'prepare a safe restart'],
    ['orcad_update_legacy_host', 'you can continue an interrupted chat after the update']
  ])('explains the chat update refusal %s before generic verdict copy', (code, instruction) => {
    expect(
      managedServerOutcomeLabel({ outcome: 'deferred', code, verdict: 'unverifiable' })
    ).toContain(instruction)
  })

  it('explains the active-server guard before interpreting its live verdict as terminals', () => {
    expect(
      managedServerOutcomeLabel({
        outcome: 'refused',
        code: 'orcad_stop_active_environment',
        verdict: 'live'
      })
    ).toBe(
      'Not done: this server is the default host for new projects. Choose another one in Advanced before stopping it.'
    )
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

  it.each(['terminals_running', 'legacy_host'])('warns once for Force: %s', (suffix) => {
    const code = `orcad_update_${suffix}`
    const label = managedServerOutcomeLabel({ outcome: 'deferred', code }, true)
    expect(label.split('On older servers that cannot check for running chats')).toHaveLength(2)
    expect(label).toContain('you can continue an interrupted chat after the update.')
  })

  it('keeps an unanswered census unverifiable', () => {
    expect(managedServerOutcomeLabel({ outcome: 'refused', verdict: 'unverifiable' })).toContain(
      'couldn’t confirm what is running'
    )
  })
})
