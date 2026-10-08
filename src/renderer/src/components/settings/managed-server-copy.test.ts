import { describe, expect, it } from 'vitest'
import { ORCAD_MIGRATION_DEPENDENCY_KINDS } from '../../../../shared/orcad-migration-preflight'
import { conversionBlockerLabel } from './managed-server-copy'
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
