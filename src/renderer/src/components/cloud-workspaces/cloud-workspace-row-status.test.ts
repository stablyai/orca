import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { rowStatusLabel } from './CloudWorkspaceRow'
import { workspace as fixture } from './cloud-workspaces.test-fixture'

const NOW = Date.UTC(2026, 10, 16, 12)
const DAY = 86_400_000

const workspace = (over: Partial<CloudWorkspace>): CloudWorkspace =>
  fixture({ status: 'suspended', archivedAt: null, ...over })

describe('row status: idle-deletion countdown', () => {
  it('an asleep workspace in its last 7 days says when it deletes', () => {
    expect(rowStatusLabel(workspace({ idleDeleteAt: NOW + 3 * DAY }), translate, NOW)).toBe(
      'Asleep · deletes in 3 days'
    )
    expect(rowStatusLabel(workspace({ idleDeleteAt: NOW - 1 }), translate, NOW)).toBe(
      'Asleep · deletes today'
    )
  })

  it('no countdown outside the window, from an older control plane, or once it is not asleep', () => {
    expect(rowStatusLabel(workspace({ idleDeleteAt: null }), translate, NOW)).toBe('Asleep')
    expect(rowStatusLabel(workspace({}), translate, NOW)).toBe('Asleep')
    expect(rowStatusLabel(workspace({ status: 'running', idleDeleteAt: NOW + DAY }), translate, NOW)).toBe(
      'Running'
    )
    expect(
      rowStatusLabel(workspace({ archivedAt: NOW - DAY, idleDeleteAt: NOW + DAY }), translate, NOW)
    ).toBe('Archived')
  })
})
