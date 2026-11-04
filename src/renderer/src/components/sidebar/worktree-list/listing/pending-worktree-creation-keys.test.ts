import { expect, it } from 'vitest'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { selectPendingWorktreeCreationKeys } from './pending-worktree-creation-keys'
import { withWindowCreations } from './window-worktree-creations'
import type { SidebarFeedDomains } from '../../../../../../shared/sidebar-list/sidebar-feed-domains'

it('keeps visible and hidden window creations host-qualified without flashing hidden feed entries', () => {
  const entry = (creationId: string, loaderVisible: boolean): PendingWorktreeCreation => ({
    creationId,
    loaderVisible,
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    request: {
      repoId: 'repo with space',
      executionHostId: 'runtime:server',
      name: 'workspace',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    }
  })
  const pending = { visible: entry('visible', true), hidden: entry('hidden', false) }
  const visible = selectPendingWorktreeCreationKeys(pending)
  const hidden = selectPendingWorktreeCreationKeys(pending, 'hidden')
  expect(visible).toEqual(['visible runtime:server\0repo with space'])
  expect(hidden).toEqual(['hidden runtime:server\0repo with space'])
  expect(selectPendingWorktreeCreationKeys(pending)).toBe(visible)
  expect(selectPendingWorktreeCreationKeys(pending, 'hidden')).toBe(hidden)
  const domains: SidebarFeedDomains = {
    workspaces: new Map(),
    activity: new Map(),
    review: new Map(),
    creations: new Map([['hidden', { repoId: 'repo with space' }]]),
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: null,
    projectCatalog: null,
    retention: null
  }
  const listed = withWindowCreations(domains, visible, new Set(), hidden)
  expect([...listed.creations]).toEqual([['visible', { repoId: 'repo with space' }]])
  expect(domains.creations.has('hidden')).toBe(true)
})
