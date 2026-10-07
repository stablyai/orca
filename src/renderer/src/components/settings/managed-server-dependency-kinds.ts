/** Plain names for the kinds of saved state that can keep a host from moving. */
import type { OrcadMigrationDependencyKind } from '../../../../shared/orcad-migration-preflight'
import { translate } from '@/i18n/i18n'

export function dependencyKindLabel(kind: OrcadMigrationDependencyKind): string {
  switch (kind) {
    case 'saved-port-forward':
      return translate('auto.components.settings.managedServers.kind.portForward', 'port forwards')
    case 'terminal-lease':
      return translate('auto.components.settings.managedServers.kind.terminalLease', 'terminals')
    case 'terminal-recovery':
      return translate(
        'auto.components.settings.managedServers.kind.terminalRecovery',
        'terminal recovery records'
      )
    case 'workspace-session':
      return translate(
        'auto.components.settings.managedServers.kind.workspaceSession',
        'open tabs and layout'
      )
    case 'worktree-metadata':
      return translate(
        'auto.components.settings.managedServers.kind.worktreeMetadata',
        'worktree details'
      )
    case 'worktree-lineage':
      return translate(
        'auto.components.settings.managedServers.kind.worktreeLineage',
        'worktree history'
      )
    case 'workspace-lineage':
      return translate(
        'auto.components.settings.managedServers.kind.workspaceLineage',
        'workspace history'
      )
    case 'sparse-preset':
      return translate(
        'auto.components.settings.managedServers.kind.sparsePreset',
        'sparse checkout presets'
      )
    case 'retired-worktree-name':
      return translate(
        'auto.components.settings.managedServers.kind.retiredWorktreeName',
        'retired worktree names'
      )
    case 'automation':
      return translate('auto.components.settings.managedServers.kind.automation', 'automations')
    case 'automation-run':
      return translate(
        'auto.components.settings.managedServers.kind.automationRun',
        'automation runs'
      )
    case 'mobile-tab-selection':
      return translate(
        'auto.components.settings.managedServers.kind.mobileTabSelection',
        'mobile tab selections'
      )
    case 'ui-routing':
      return translate(
        'auto.components.settings.managedServers.kind.uiRouting',
        'sidebar and filter settings'
      )
  }
}
