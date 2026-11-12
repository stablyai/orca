import React from 'react'
import { Pin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  isProjectHeaderRowPinned,
  type GroupHeaderRow
} from '../../../../../../shared/sidebar-list/row-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

export function getProjectHeaderPinTargetRepos(row: GroupHeaderRow): Repo[] {
  if (row.pinTargetRepos && row.pinTargetRepos.length > 0) {
    return [...row.pinTargetRepos]
  }
  if (row.hostRepos) {
    return [...row.hostRepos.values()]
  }
  if (row.anchorRepo && row.repo && !isSameRepoRow(row.anchorRepo, row.repo)) {
    return [row.anchorRepo, row.repo]
  }
  return row.repo ? [row.repo] : []
}

export function hasSectionHeaderTitlePinBadge(
  row: GroupHeaderRow,
  isRepoHeader: boolean,
  isProjectGroupHeader: boolean,
  projectGroupId: string | undefined,
  hasTogglePinProject: boolean,
  hasTogglePinProjectGroup: boolean
): boolean {
  if (isRepoHeader && isProjectHeaderRowPinned(row) && hasTogglePinProject) {
    return true
  }
  return Boolean(
    isProjectGroupHeader &&
    !row.repo &&
    projectGroupId &&
    row.projectGroup &&
    'createdFrom' in row.projectGroup &&
    row.projectGroup.isPinned === true &&
    hasTogglePinProjectGroup
  )
}

export function SectionHeaderPinButton({
  ariaLabel,
  tooltip,
  onUnpin
}: {
  ariaLabel: string
  tooltip: string
  onUnpin: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="chip"
          data-repo-header-action=""
          aria-label={ariaLabel}
          className="group/pin size-4 shrink-0"
          onPointerDown={handleRepoHeaderActionPointerDown}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onUnpin()
          }}
        >
          <Pin
            className="size-3 text-muted-foreground group-hover/pin:text-accent-foreground"
            aria-hidden="true"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function SectionHeaderTitlePinBadge({
  row,
  label,
  isRepoHeader,
  isProjectGroupHeader,
  projectGroupId,
  projectGroupHostId,
  onTogglePinProject,
  onTogglePinProjectGroup
}: {
  row: GroupHeaderRow
  label: string
  isRepoHeader: boolean
  isProjectGroupHeader: boolean
  projectGroupId?: string
  projectGroupHostId?: ExecutionHostId
  onTogglePinProject?: (repos: readonly Repo[], nextPinned: boolean) => void
  onTogglePinProjectGroup?: (groupId: string, nextPinned: boolean, hostId?: ExecutionHostId) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (isRepoHeader && isProjectHeaderRowPinned(row) && onTogglePinProject) {
    return (
      <SectionHeaderPinButton
        ariaLabel={t(
          'auto.components.sidebar.WorktreeList.unpinItemAriaLabel',
          'Unpin {{value0}}',
          {
            value0: label
          }
        )}
        tooltip={t('auto.components.sidebar.WorktreeList.unpinProject', 'Unpin project')}
        onUnpin={() => onTogglePinProject(getProjectHeaderPinTargetRepos(row), false)}
      />
    )
  }
  if (
    isProjectGroupHeader &&
    !row.repo &&
    projectGroupId &&
    row.projectGroup &&
    'createdFrom' in row.projectGroup &&
    row.projectGroup.isPinned === true &&
    onTogglePinProjectGroup
  ) {
    return (
      <SectionHeaderPinButton
        ariaLabel={t(
          'auto.components.sidebar.WorktreeList.unpinItemAriaLabel',
          'Unpin {{value0}}',
          {
            value0: label
          }
        )}
        tooltip={t('auto.components.sidebar.WorktreeList.unpinGroup', 'Unpin group')}
        onUnpin={() => onTogglePinProjectGroup(projectGroupId, false, projectGroupHostId)}
      />
    )
  }
  return null
}
