import { expect, it } from 'vitest'
import {
  assertOrcadMigrationProvisionalTabs,
  inspectOrcadMigrationMirrorCohort,
  assertOrcadMigrationMirrorApplied
} from './orcad-migration-mirror-cohort'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'

const workspace = {
  workspaceId: 'folder:folder-a',
  terminals: [
    {
      tabId: 'tab-a',
      leafId: 'leaf-a',
      sourcePtyId: 'ssh:source:pty',
      incarnationId: 'incarnation-a'
    }
  ]
}
const surface = {
  type: 'terminal' as const,
  parentTabId: 'tab-a',
  leafId: 'leaf-a',
  incarnationId: 'incarnation-a',
  status: 'ready' as const,
  terminal: 'destination-handle'
}
const snapshot = (tabs: unknown[] = [surface]) =>
  ({ worktree: workspace.workspaceId, tabs }) as Parameters<
    typeof inspectOrcadMigrationMirrorCohort
  >[1]
const state = () =>
  ({
    tabsByWorktree: { [workspace.workspaceId]: [{ id: 'tab-a', ptyId: 'ssh:source:pty' }] },
    ptyIdsByTabId: { 'tab-a': ['ssh:source:pty'] },
    terminalLayoutsByTabId: {},
    pendingStartupByTabId: {}
  }) as unknown as Parameters<typeof assertOrcadMigrationProvisionalTabs>[0]

it('accepts the exact source cohort without changing it', () => {
  const current = state()
  const before = structuredClone(current)
  assertOrcadMigrationProvisionalTabs(current, workspace)
  expect(current).toEqual(before)
})

it.each(['row', 'layout', 'startup'] as const)(
  'refuses a newer %s before raw-tab replacement',
  (kind) => {
    const current = state()
    if (kind === 'row') {
      current.tabsByWorktree[workspace.workspaceId][0].ptyId = 'new-source-pty'
    }
    if (kind === 'layout') {
      current.terminalLayoutsByTabId['tab-a'] = {
        ptyIdsByLeafId: { leaf: 'new-source-pty' }
      } as never
    }
    if (kind === 'startup') {
      current.pendingStartupByTabId['tab-a'] = { command: 'new launch' } as never
    }
    const before = structuredClone(current)
    expect(() => assertOrcadMigrationProvisionalTabs(current, workspace)).toThrow(
      'source_identity_changed'
    )
    expect(current).toEqual(before)
  }
)

it.each([
  { tabs: [] },
  { tabs: [surface, surface] },
  { tabs: [{ ...surface, incarnationId: 'replacement' }] },
  { tabs: [{ ...surface, incarnationId: undefined }] },
  { tabs: [{ ...surface, status: 'pending-handle', terminal: null }] }
])('refuses missing, duplicate or unverifiable destination incarnation %j', ({ tabs }) => {
  expect(() => inspectOrcadMigrationMirrorCohort(workspace, snapshot(tabs))).toThrow(
    'cohort_unverified'
  )
})

it('requires canonical mirrored identity and the observed handle, not a connected raw pane', () => {
  const current = state()
  const handles = inspectOrcadMigrationMirrorCohort(workspace, snapshot())
  expect(() => assertOrcadMigrationMirrorApplied(current, 'env', workspace, handles)).toThrow(
    'not_applied'
  )
  current.tabsByWorktree[workspace.workspaceId] = [{ id: 'web-terminal-tab-a' }] as never
  current.terminalLayoutsByTabId['web-terminal-tab-a'] = {
    ptyIdsByLeafId: { 'leaf-a': toRemoteRuntimePtyId('wrong', 'env') }
  } as never
  expect(() => assertOrcadMigrationMirrorApplied(current, 'env', workspace, handles)).toThrow(
    'not_applied'
  )
  current.terminalLayoutsByTabId['web-terminal-tab-a'].ptyIdsByLeafId!['leaf-a'] =
    toRemoteRuntimePtyId('destination-handle', 'env')
  assertOrcadMigrationMirrorApplied(current, 'env', workspace, handles)
})
