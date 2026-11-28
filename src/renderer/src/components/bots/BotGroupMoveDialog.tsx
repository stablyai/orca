import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { BotFolderMoveDialog } from './BotFolderMoveDialog'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { buildBotSidebarFolderRows } from './bot-sidebar-folder-rows'
import { moveBotGroupInSidebar } from './unfold-bot-sidebar-folders'

export function BotGroupMoveDialog({
  group,
  groups,
  onClose
}: {
  group: BotGroup
  groups: readonly BotGroup[]
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const groupParents = useAppStore((s) => s.botSidebarFolders.groupParents)
  const groupKey = botSidebarEntryKey(group)
  const choices = useMemo(() => {
    const rows = buildBotSidebarFolderRows({
      entries: groups.map((value) => ({
        kind: 'group' as const,
        id: botSidebarEntryKey(value),
        name: value.name
      })),
      folders: [],
      folderPlacements: {},
      groupParents,
      isExpanded: () => true,
      isGroupExpanded: (id) => id !== groupKey
    })
    return rows.flatMap((row) =>
      row.kind === 'entry' && row.id !== groupKey
        ? [{ id: row.id, name: row.entry.name, depth: row.depth, kind: 'group' as const }]
        : []
    )
  }, [groups, groupParents, groupKey])
  const currentParent = groupParents[groupKey]
  return (
    <BotFolderMoveDialog
      open
      title={t('bots.groups.moveGroupTitle', 'Move group')}
      description={t('bots.groups.moveGroupDescription', 'Choose a parent for {{name}}.', {
        name: group.name
      })}
      destinations={[{ id: null, name: t('bots.folders.root', 'Top level'), depth: 0 }, ...choices]}
      value={choices.some(({ id }) => id === currentParent) ? currentParent : null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
      onMove={(parentKey) => {
        moveBotGroupInSidebar(groupKey, parentKey)
        onClose()
      }}
    />
  )
}
