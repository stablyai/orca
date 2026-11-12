import type { AutomationAuthorityRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AutomationHostCatalogView } from './hosts/use-automation-host-catalog'
import type { AutomationCreateDestinationControl } from './authoring/use-automation-create-destination'
import type { ExternalAutomationListEntry } from './external/external-automation-list-entries'
import type { AutomationListRow } from './listing/automation-list-row-identity'
import type { AutomationListViewItem } from './listing/automation-list-view'
import type { AutomationTemplate } from './authoring/automation-templates'

export type ListPanelProps = {
  sortedListItems: readonly AutomationListViewItem[]
  selectedExternal: ExternalAutomationListEntry | null
  externalActionKey: string | null
  requestExternalAction: (
    manager: ExternalAutomationListEntry['manager'],
    job: ExternalAutomationListEntry['job'],
    action: 'run' | 'pause' | 'resume' | 'delete',
    scope: ExternalAutomationListEntry['scope']
  ) => void
  hasListItems: boolean
  hasFilteredListItems: boolean
  selectedRowKey: string | null
  selectedExternalKey: string | null
  hostCatalog: AutomationHostCatalogView
  searchCounts: { hostRowCount: number; visibleRowCount: number; searchActive: boolean }
  externalManagersUncheckedNotice: string | null
  isActionEnabled: (row: AutomationListRow, action: string) => boolean
  onSelectHost: (filter: unknown) => void
  selectAutomationRow: (rowKey: string | null) => void
  selectExternalKey: (entryKey: string | null) => void
  onOpenDetail: () => void
  onRefresh: () => void
  runNow: (row: AutomationListRow) => void
  openEditDialog: (row: AutomationListRow) => void
  toggleAutomation: (row: AutomationListRow) => void
  requestDeleteAutomation: (row: AutomationListRow) => void
  openCreateDialog: () => void
}

export type EditorDialogProps = {
  launchAuthority?: AutomationAuthorityRef
  open: boolean
  isEditing: boolean
  isSaving: boolean
  createDestination?: AutomationCreateDestinationControl
  editDestination?: AutomationCreateDestinationControl
  notice?: { message: string; recovery: string | null } | null
  onNoticeRecover?: (action: string) => void
  repos?: { id: string }[]
  worktrees: Worktree[]
  draft?: { projectId: string; workspaceId: string }
  canSave?: boolean
  onSave: () => void
  onProjectChange: (projectId: string) => void
  onDraftChange: (updater: (current: unknown) => unknown) => void
  onApplyTemplate: (template: AutomationTemplate) => void
}

export type DeleteDialogProps = {
  deleteTarget: Automation | null
  onConfirm: () => void
}
