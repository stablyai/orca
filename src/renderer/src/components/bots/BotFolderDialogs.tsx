import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { recordCollapsedGroupChanges } from '@/store/slices/ui/collapsed-group-toggle'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import {
  addBotSidebarFolder,
  canMoveBotSidebarFolder,
  getBotSidebarFolderGroupKey,
  indexBotSidebarFolders,
  listBotSidebarFolders,
  moveBotSidebarFolder,
  removeBotSidebarFolder,
  renameBotSidebarFolder,
  withBotSidebarFolderPlacement
} from '../../../../shared/bots/bot-sidebar-folders'
import { BotFolderNameDialog } from './BotFolderNameDialog'
import { BotFolderMoveDialog, botFolderDestinations } from './BotFolderMoveDialog'
import { BotFolderRemoveDialog } from './BotFolderRemoveDialog'
import { unfoldBotSidebarFolder } from './unfold-bot-sidebar-folders'

export type BotFolderDialogState =
  | { type: 'create'; parentId: string | null }
  | { type: 'rename'; folderId: string }
  | { type: 'move'; folderId: string }
  | { type: 'remove'; folderId: string }
  | { type: 'moveBot'; entryKey: string; name: string }

export function BotFolderDialogs({
  state,
  onClose
}: {
  state: BotFolderDialogState
  onClose: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const view = useAppStore((s) => s.botSidebarFolders)
  const setView = useAppStore((s) => s.setBotSidebarFolders)
  const foldersById = indexBotSidebarFolders(view.folders)
  const rootName = t('bots.folders.root', 'Top level')
  const readView = () => useAppStore.getState().botSidebarFolders
  const closeOnDismiss = (open: boolean): void => {
    if (!open) {
      onClose()
    }
  }
  if (state.type === 'moveBot') {
    const folderId = view.placements[state.entryKey]
    return (
      <BotFolderMoveDialog
        open
        title={t('bots.folders.moveBotTitle', 'Move bot')}
        description={t('bots.folders.moveBotDescription', 'Choose a folder for {{name}}.', {
          name: state.name
        })}
        destinations={botFolderDestinations(listBotSidebarFolders(view.folders), rootName)}
        value={foldersById.has(folderId) ? folderId : null}
        onOpenChange={closeOnDismiss}
        onMove={(destination) => {
          const current = readView()
          if (destination === null || current.folders.some(({ id }) => id === destination)) {
            setView({
              ...current,
              placements: withBotSidebarFolderPlacement(
                current.placements,
                state.entryKey,
                destination
              )
            })
            if (destination !== null) {
              unfoldBotSidebarFolder(destination)
            }
          }
          onClose()
        }}
      />
    )
  }
  if (state.type === 'create') {
    const parent = state.parentId ? foldersById.get(state.parentId) : undefined
    return (
      <BotFolderNameDialog
        open
        title={
          parent
            ? t('bots.folders.createChildTitle', 'New subfolder')
            : t('bots.folders.createTitle', 'New folder')
        }
        description={
          parent
            ? t('bots.folders.createChildDescription', 'Create a subfolder in {{name}}.', {
                name: parent.name
              })
            : t('bots.folders.createDescription', 'Create a folder in the Bots sidebar.')
        }
        nameLabel={t('bots.folders.nameLabel', 'Folder name')}
        confirmLabel={t('bots.folders.createConfirm', 'Create folder')}
        initialName=""
        onOpenChange={closeOnDismiss}
        onSubmit={(name) => {
          const current = readView()
          setView({
            ...current,
            folders: addBotSidebarFolder(current.folders, {
              id: createNonSecureContextUuid(),
              name,
              parentId: state.parentId
            })
          })
          if (state.parentId) {
            unfoldBotSidebarFolder(state.parentId)
          }
          onClose()
        }}
      />
    )
  }
  const target = foldersById.get(state.folderId)
  if (!target) {
    return null
  }
  if (state.type === 'rename') {
    return (
      <BotFolderNameDialog
        open
        title={t('bots.folders.renameTitle', 'Rename folder')}
        description={t('bots.folders.renameDescription', 'Choose a new name for {{name}}.', {
          name: target.name
        })}
        nameLabel={t('bots.folders.nameLabel', 'Folder name')}
        confirmLabel={t('bots.folders.renameConfirm', 'Save')}
        initialName={target.name}
        onOpenChange={closeOnDismiss}
        onSubmit={(name) => {
          const current = readView()
          setView({ ...current, folders: renameBotSidebarFolder(current.folders, target.id, name) })
          onClose()
        }}
      />
    )
  }
  if (state.type === 'move') {
    return (
      <BotFolderMoveDialog
        open
        title={t('bots.folders.moveTitle', 'Move folder')}
        description={t('bots.folders.moveDescription', 'Choose where {{name}} goes.', {
          name: target.name
        })}
        destinations={botFolderDestinations(
          listBotSidebarFolders(view.folders, target.id),
          rootName
        )}
        value={target.parentId}
        onOpenChange={closeOnDismiss}
        onMove={(parentId) => {
          const current = readView()
          if (canMoveBotSidebarFolder(current.folders, target.id, parentId)) {
            setView({
              ...current,
              folders: moveBotSidebarFolder(current.folders, target.id, parentId)
            })
            if (parentId) {
              unfoldBotSidebarFolder(parentId)
            }
          }
          onClose()
        }}
      />
    )
  }
  const parentName = target.parentId
    ? (foldersById.get(target.parentId)?.name ?? rootName)
    : rootName
  return (
    <BotFolderRemoveDialog
      open
      folderName={target.name}
      parentName={parentName}
      onOpenChange={closeOnDismiss}
      onConfirm={() => {
        const current = readView()
        setView({
          ...current,
          ...removeBotSidebarFolder(current.folders, current.placements, target.id)
        })
        const { collapsedGroups, setCollapsedGroups } = useAppStore.getState()
        const foldKey = getBotSidebarFolderGroupKey(target.id)
        if (collapsedGroups.has(foldKey)) {
          const next = new Set(collapsedGroups)
          next.delete(foldKey)
          setCollapsedGroups(recordCollapsedGroupChanges(collapsedGroups, next, [foldKey]))
        }
        onClose()
      }}
    />
  )
}
