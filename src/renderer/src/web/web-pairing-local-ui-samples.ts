import type { PairingLocalUiField } from '../../../shared/pairing-local-ui-fields'

export const browserLocalUiSamples: Record<PairingLocalUiField, unknown> = {
  automationHostFilter: { kind: 'host', hostKey: 'browser-local-host-key' },
  hideWorkspacesFromOtherDevices: true,
  manualRepoOrder: [{ hostId: 'runtime:web-env-1', repoId: 'repo-b' }],
  hideSleepingProjectKeys: ['local\0repo-a'],
  workspaceHostOrder: ['runtime:web-env-1', 'local'],
  agentsVisibleHostIds: ['runtime:web-env-1'],
  agentsFilterRepoIds: ['repo-b'],
  agentsShowChildAgents: true,
  agentsCompactMode: false,
  agentsShowSearch: false,
  agentsReadFilter: 'unread',
  agentsGroupBy: 'project',
  activityClearedAtByPaneKey: { 'tab-1:leaf-1': 123 },
  manuallyUnreadTurnsByPaneKey: { 'tab-1:leaf-1': 321 }
}
export const hostUiSamples: Record<PairingLocalUiField, unknown> = {
  automationHostFilter: { kind: 'all' },
  hideWorkspacesFromOtherDevices: false,
  manualRepoOrder: [{ hostId: 'local', repoId: 'repo-a' }],
  hideSleepingProjectKeys: ['ssh:host\0repo-host'],
  workspaceHostOrder: ['local', 'ssh:box'],
  agentsVisibleHostIds: ['local'],
  agentsFilterRepoIds: ['repo-a'],
  agentsShowChildAgents: false,
  agentsCompactMode: true,
  agentsShowSearch: true,
  agentsReadFilter: 'all',
  agentsGroupBy: 'status',
  activityClearedAtByPaneKey: { 'tab-2:leaf-2': 456 },
  manuallyUnreadTurnsByPaneKey: { 'tab-2:leaf-2': 654 }
}
