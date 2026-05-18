import { describe, expect, it } from 'vitest'
import { migrationUnsupportedToAgentStatusEntry } from './migration-unsupported-agent-entry'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'

describe('migrationUnsupportedToAgentStatusEntry', () => {
  it('returns a stable synthetic entry for the same migration record', () => {
    const unsupported: MigrationUnsupportedPtyEntry = {
      ptyId: 'pty-1',
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 1234
    }

    const first = migrationUnsupportedToAgentStatusEntry(unsupported)
    const second = migrationUnsupportedToAgentStatusEntry(unsupported)

    expect(second).toBe(first)
    expect(first?.updatedAt).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('caches null for records that cannot be projected to a pane key', () => {
    const unsupported: MigrationUnsupportedPtyEntry = {
      ptyId: 'pty-1',
      reason: 'legacy-numeric-pane-key',
      source: 'ssh',
      updatedAt: 1234
    }

    expect(migrationUnsupportedToAgentStatusEntry(unsupported)).toBeNull()
    expect(migrationUnsupportedToAgentStatusEntry(unsupported)).toBeNull()
  })
})
