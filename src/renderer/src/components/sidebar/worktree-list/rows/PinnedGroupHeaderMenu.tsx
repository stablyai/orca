import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { stopRepoHeaderMenuEvent } from './header-event-guards'
import { useState } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  movePinnedGroup,
  removePinnedGroup,
  renamePinnedGroup
} from '@/store/pinned-groups/pinned-group-actions'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'

export function PinnedGroupHeaderMenu({ groupId, label }: { groupId: string; label: string }) {
  const t = useTranslate()
  const groups = useAppStore((s) => s.settings?.pinnedGroups)
  const ordered = [...(groups ?? [])].sort((a, b) => a.order - b.order)
  const index = ordered.findIndex((group) => group.id === groupId)
  const [renaming, setRenaming] = useState(false)
  return (
    <div
      role="presentation"
      className="contents"
      onClick={stopRepoHeaderMenuEvent}
      onKeyDown={stopRepoHeaderMenuEvent}
      onPointerDown={stopRepoHeaderMenuEvent}
    >
      <ProjectGroupHeaderMenu
        groupId={groupId}
        projectGroup={null}
        label={label}
        onRename={() => setRenaming(true)}
        onDelete={() => {
          void removePinnedGroup(groupId).catch(console.error)
        }}
        removeLabel={t('auto.components.sidebar.PinnedGroups.removeGroup', 'Remove group')}
      >
        <DropdownMenuItem
          disabled={index <= 0}
          onSelect={() => {
            void movePinnedGroup(groupId, -1).catch(console.error)
          }}
        >
          {t('auto.components.sidebar.PinnedGroups.moveUp', 'Move up')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === -1 || index >= ordered.length - 1}
          onSelect={() => {
            void movePinnedGroup(groupId, 1).catch(console.error)
          }}
        >
          {t('auto.components.sidebar.PinnedGroups.moveDown', 'Move down')}
        </DropdownMenuItem>
      </ProjectGroupHeaderMenu>
      <ProjectGroupNameDialog
        open={renaming}
        title={t('auto.components.sidebar.PinnedGroups.renameGroup', 'Rename pin group')}
        description={t(
          'auto.components.sidebar.PinnedGroups.nameDescription',
          'Name this group in Pinned.'
        )}
        initialName={label}
        confirmLabel={t('auto.components.sidebar.ProjectGroupNameDialog.rename', 'Rename')}
        onOpenChange={setRenaming}
        onSubmit={(name) => renamePinnedGroup(groupId, name)}
      />
    </div>
  )
}

export function PinnedGroupHeaderActions({ row }: { row: GroupHeaderRow }) {
  return row.key.startsWith('pinned-group:') ? (
    <PinnedGroupHeaderMenu
      groupId={row.key.slice('pinned-group:'.length)}
      label={row.label ?? ''}
    />
  ) : null
}
