import { useMemo } from 'react'
import { WorktreeRemoveParentMenuItem } from './WorktreeRemoveParentMenuItem'
import {
  CircleX,
  Copy,
  FolderPlus,
  FolderTree,
  Folders,
  GitBranchPlus,
  GitFork,
  Workflow
} from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import {
  agentSessionTabsOfRow,
  getWorktreeParentPickerLabel,
  isWorktreeParentPickerDisabled
} from './worktree-context-menu-policy'

export function WorktreeCopySubMenu({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  const { isDeleting } = model
  const tabs = useAppStore((s) => s.unifiedTabsByWorktree[model.worktree.id])
  const rowHostId = model.worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(model.worktree.runtimeOwnerEnvironmentId)
    : model.worktree.hostId
  const agentSessionTabs = useMemo(
    () => (model.isMultiContext ? [] : agentSessionTabsOfRow(tabs ?? [], rowHostId)),
    [model.isMultiContext, rowHostId, tabs]
  )
  const [singleAgentTab] = agentSessionTabs
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isDeleting}>
        <Copy className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.copySubmenu', 'Copy')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={model.handleCopyPath} disabled={isDeleting}>
          <Copy className="size-3.5" />
          {t('auto.components.sidebar.WorktreeContextMenu.copyPathOption', 'Path')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={model.handleCopyName} disabled={isDeleting}>
          <Copy className="size-3.5" />
          {t('auto.components.sidebar.WorktreeContextMenu.copyNameOption', 'Copy workspace title')}
        </DropdownMenuItem>
        {agentSessionTabs.length === 1 && singleAgentTab ? (
          <>
            <DropdownMenuItem
              onSelect={() => model.handleCopyAgentTabId(singleAgentTab)}
              disabled={isDeleting}
            >
              <Copy className="size-3.5" />
              {t('auto.components.sidebar.WorktreeContextMenu.copyTabIdOption', 'Copy Tab ID')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => model.handleCopyAgentSessionId(singleAgentTab)}
              disabled={isDeleting}
            >
              <Copy className="size-3.5" />
              {t(
                'auto.components.sidebar.WorktreeContextMenu.copySessionIdOption',
                'Copy Orca Session ID'
              )}
            </DropdownMenuItem>
          </>
        ) : null}
        {agentSessionTabs.length > 1 ? (
          <>
            <CopyAgentTabsSubMenu
              label={t(
                'auto.components.sidebar.WorktreeContextMenu.copyTabIdOption',
                'Copy Tab ID'
              )}
              agentSessionTabs={agentSessionTabs}
              isDeleting={isDeleting}
              onCopy={model.handleCopyAgentTabId}
            />
            <CopyAgentTabsSubMenu
              label={t(
                'auto.components.sidebar.WorktreeContextMenu.copySessionIdOption',
                'Copy Orca Session ID'
              )}
              agentSessionTabs={agentSessionTabs}
              isDeleting={isDeleting}
              onCopy={model.handleCopyAgentSessionId}
            />
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function agentTabMenuLabel(tab: Tab): string {
  return tab.customLabel || tab.label || tab.entityId
}

function CopyAgentTabsSubMenu({
  label,
  agentSessionTabs,
  isDeleting,
  onCopy
}: {
  label: string
  agentSessionTabs: readonly Tab[]
  isDeleting: boolean
  onCopy: (tab: Tab) => void
}): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isDeleting}>
        <Copy className="size-3.5" />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent scrollable>
        {agentSessionTabs.map((tab) => (
          <DropdownMenuItem key={tab.id} onSelect={() => onCopy(tab)} disabled={isDeleting}>
            <Copy className="size-3.5" />
            <span className="max-w-48 truncate">{agentTabMenuLabel(tab)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function WorktreeLineageSubMenu({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  const { isDeleting, validParentWorktreeId, hasParentLink } = model
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isDeleting}>
        <GitFork className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.lineageSubmenu', 'Parent & Children')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {model.canCreateChildWorktree ? (
          <DropdownMenuItem onSelect={model.handleNewChildWorktree} disabled={isDeleting}>
            <GitBranchPlus className="size-3.5" />
            {t(
              'auto.components.sidebar.WorktreeContextMenu.newChildWorktree',
              'New Child Worktree...'
            )}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={model.handleOpenParentPicker}
          disabled={isWorktreeParentPickerDisabled({
            isDeleting,
            eligibleParentCount: model.eligibleParentCount
          })}
        >
          <FolderTree className="size-3.5" />
          {getWorktreeParentPickerLabel(validParentWorktreeId, t)}
        </DropdownMenuItem>
        {validParentWorktreeId ? (
          <DropdownMenuItem onSelect={model.handleOpenParent} disabled={isDeleting}>
            <Workflow className="size-3.5" />
            {t('auto.components.sidebar.WorktreeContextMenu.8d9cd19d09', 'Open Parent Worktree')}
          </DropdownMenuItem>
        ) : null}
        {hasParentLink ? (
          <WorktreeRemoveParentMenuItem
            worktree={model.worktree}
            onSelect={model.handleRemoveParentLink}
            disabled={isDeleting}
          />
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

// Kept here as well as the project header: that header menu only renders when grouping by project.
export function WorktreeProjectGroupSubMenu({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  const { repo, projectGroups, isDeleting } = model
  if (!repo) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isDeleting}>
        <Folders className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.projectGroupSubmenu', 'Project Group')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={model.handleCreateGroupFromRepo} disabled={isDeleting}>
          <FolderPlus className="size-3.5" />
          {t('auto.components.sidebar.WorktreeContextMenu.503ec0f8e6', 'New group from project')}
        </DropdownMenuItem>
        {repo.projectGroupId ? (
          <DropdownMenuItem onSelect={model.handleRemoveProjectFromGroup} disabled={isDeleting}>
            <CircleX className="size-3.5" />
            {t('auto.components.sidebar.WorktreeContextMenu.d35dfeae58', 'Remove from group')}
          </DropdownMenuItem>
        ) : null}
        {projectGroups.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {t('auto.components.sidebar.WorktreeContextMenu.76865d827f', 'Move to group')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={repo.projectGroupId ?? ''}
              onValueChange={model.handleMoveProjectToGroup}
            >
              {projectGroups.map((group) => (
                <DropdownMenuRadioItem
                  key={group.id}
                  value={group.id}
                  textValue={group.name}
                  disabled={isDeleting || repo.projectGroupId === group.id}
                >
                  <span className="max-w-48 truncate">{group.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
