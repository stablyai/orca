import type { SubmitFolderWorkspaceCreateParams } from './folder-workspace-composer-submit-input'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import {
  buildWorkspaceSourceSelection,
  getWorkspaceSourceName,
  getWorkspaceSourceProvider,
  shouldApplyWorkspaceSourceAutoName
} from '../../../../../../shared/new-workspace/workspace-source'
import '../../../../../../shared/cross-platform-path'
import '../../../../../../shared/execution-host'
import '../../../../../../shared/project-groups'
import '../../../../../../shared/repo-kind'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'

import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/smart-workspace-name-field-model'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import './folder-workspace-source-repos'

export function toFolderWorkspaceLinkedTask(
  item: LinkedWorkItemSummary | null
): FolderWorkspace['linkedTask'] {
  if (!item) {
    return null
  }
  const provider = getWorkspaceSourceProvider(item)
  return {
    provider,
    type: item.type,
    number: item.number,
    title: item.title,
    url: item.url,
    ...(item.linearIdentifier ? { linearIdentifier: item.linearIdentifier } : {}),
    ...(item.jiraIdentifier ? { jiraIdentifier: item.jiraIdentifier } : {}),
    ...(item.repoId ? { repoId: item.repoId } : {})
  }
}

export function getSmartNameSelection(
  linkedWorkItem: LinkedWorkItemSummary | null
): SmartWorkspaceNameSelection | null {
  return buildWorkspaceSourceSelection({ linkedWorkItem }) as SmartWorkspaceNameSelection | null
}

export function getLinkedItemDisplayName(item: LinkedWorkItemSummary): string | null {
  return getWorkspaceSourceName(item).displayName || null
}

export function getFolderWorkspacePrimaryActionLabel(t: Translate = translate): string {
  return t('auto.components.sidebar.FolderWorkspaceComposerDialog.create', 'Create workspace')
}

export function resolveFolderWorkspaceName({
  projectGroup,
  name,
  lastAutoName,
  linkedWorkItem
}: Pick<
  SubmitFolderWorkspaceCreateParams,
  'projectGroup' | 'name' | 'lastAutoName' | 'linkedWorkItem'
>): string {
  const linkedName = linkedWorkItem ? getLinkedItemDisplayName(linkedWorkItem) : null
  const nameIsAutoManaged = shouldApplyWorkspaceSourceAutoName({
    currentName: name,
    lastAutoName,
    lookupTextIsQuery: !linkedWorkItem
  })
  return nameIsAutoManaged && linkedName
    ? linkedName
    : name.trim() ||
        linkedName ||
        translate(
          'auto.components.sidebar.folderWorkspaceComposer.defaultWorkspaceName',
          '{{name}} workspace',
          { name: projectGroup.name }
        )
}
