import React, { useCallback, useId, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { getWorkspacePath } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-spawn-context'
import { checkTaskGroupFolder, folderBaseName } from './agent-task-group-folder'

export type AgentTaskGroupModalData = {
  workspaceKey: string
  worktreeId: string
  /** Browsing opens this computer's picker, so it is offered for local workspaces only. */
  canBrowse: boolean
  /** Edit this group; absent creates one. */
  groupId?: string
  initialName?: string
  initialFolderPath?: string
  /** Move this conversation into the group it creates. */
  assignTabId?: string
}

function readModalData(data: Record<string, unknown>): AgentTaskGroupModalData | null {
  if (typeof data.workspaceKey !== 'string' || typeof data.worktreeId !== 'string') {
    return null
  }
  const text = (key: string) => (typeof data[key] === 'string' ? data[key] : undefined)
  return {
    workspaceKey: data.workspaceKey,
    worktreeId: data.worktreeId,
    canBrowse: data.canBrowse === true,
    groupId: text('groupId'),
    initialName: text('initialName'),
    initialFolderPath: text('initialFolderPath'),
    assignTabId: text('assignTabId')
  }
}

const AgentTaskGroupDialog = React.memo(function AgentTaskGroupDialog() {
  const t = useTranslate()
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const [data] = useState(() => readModalData(modalData))
  const workspaceRoot = useAppStore((s) => (data ? getWorkspacePath(s, data.worktreeId) : null))
  const defaultName = t(
    'auto.components.sidebar.AgentTaskGroupDialog.defaultName',
    'New Task Group'
  )
  const [name, setName] = useState(data?.initialName ?? defaultName)
  const [folder, setFolder] = useState(data?.initialFolderPath ?? '')
  const nameRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const folderId = useId()
  const folderErrorId = useId()
  const isEdit = Boolean(data?.groupId)
  const folderCheck = checkTaskGroupFolder(workspaceRoot, folder)
  const canSubmit = name.trim().length > 0 && folderCheck.kind !== 'outside'

  const browse = useCallback(async () => {
    const picked = await window.api.repos.pickFolder()
    if (!picked) {
      return
    }
    setFolder(picked)
    // A name still at its suggestion follows the folder, like a Codex project.
    setName((current) =>
      current.trim() === '' || current === defaultName ? folderBaseName(picked) : current
    )
  }, [defaultName])

  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!data || !canSubmit) {
        return
      }
      const folderPath = folderCheck.kind === 'inside' ? folderCheck.folderPath : null
      const state = useAppStore.getState()
      if (data.groupId) {
        state.renameAgentTaskGroup(data.workspaceKey, data.groupId, name)
        state.setAgentTaskGroupFolder(data.workspaceKey, data.groupId, folderPath)
      } else {
        const groupId = state.createAgentTaskGroup(data.workspaceKey, name, folderPath)
        if (groupId && data.assignTabId) {
          state.assignTabToAgentTaskGroup(data.workspaceKey, data.assignTabId, groupId)
        }
      }
      closeModal()
    },
    [canSubmit, closeModal, data, folderCheck, name]
  )

  return (
    <Dialog open={data !== null} onOpenChange={(open) => (open ? undefined : closeModal())}>
      <DialogContent
        className="max-w-md sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          nameRef.current?.focus()
          nameRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isEdit
              ? t('auto.components.sidebar.AgentTaskGroupDialog.editTitle', 'Edit Task Group')
              : t('auto.components.sidebar.AgentTaskGroupDialog.createTitle', 'New Task Group')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t(
              'auto.components.sidebar.AgentTaskGroupDialog.description',
              'Task groups organize conversations in this workspace. They share its files and create no branch or worktree.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1">
            <Label htmlFor={nameId} variant="dialog-field">
              {t('auto.components.sidebar.AgentTaskGroupDialog.name', 'Name')}
            </Label>
            <Input
              id={nameId}
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={folderId} variant="dialog-field">
              {t('auto.components.sidebar.AgentTaskGroupDialog.folder', 'Folder (optional)')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={folderId}
                value={folder}
                placeholder={workspaceRoot ?? ''}
                onChange={(event) => setFolder(event.target.value)}
                aria-invalid={folderCheck.kind === 'outside' || undefined}
                aria-describedby={folderErrorId}
                variant="code"
                className="flex-1"
              />
              {data?.canBrowse ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
                  {t('auto.components.sidebar.AgentTaskGroupDialog.browse', 'Browse…')}
                </Button>
              ) : null}
            </div>
            <p id={folderErrorId} className="text-2xs text-muted-foreground">
              {folderCheck.kind === 'outside'
                ? t(
                    'auto.components.sidebar.AgentTaskGroupDialog.outside',
                    'Pick a folder inside this workspace.'
                  )
                : t(
                    'auto.components.sidebar.AgentTaskGroupDialog.folderHint',
                    "New conversations in this group start here. Leave empty to use the workspace's root."
                  )}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={closeModal}>
              {t('auto.components.sidebar.AgentTaskGroupDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {isEdit
                ? t('auto.components.sidebar.AgentTaskGroupDialog.save', 'Save')
                : t('auto.components.sidebar.AgentTaskGroupDialog.create', 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})

export default AgentTaskGroupDialog
