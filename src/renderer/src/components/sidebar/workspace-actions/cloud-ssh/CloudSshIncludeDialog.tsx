import React, { useCallback, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudSshEditor, CloudSshStatus } from '../../../../../../shared/cloud-ssh'
import { openCloudWorkspaceInEditor } from './cloud-ssh-actions'

function readEditor(value: unknown): CloudSshEditor | null {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('label' in value)) {
    return null
  }
  const kind = 'kind' in value ? value.kind : null
  return typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    (kind === 'vscode' || kind === 'cursor')
    ? { id: value.id, label: value.label, kind }
    : null
}

function readStatus(value: unknown): CloudSshStatus | null {
  if (typeof value !== 'object' || value === null || !('hasAccess' in value)) {
    return null
  }
  const { hasAccess } = value
  return typeof hasAccess === 'boolean'
    ? {
        cloud: true,
        hasAccess,
        asleep: 'asleep' in value && value.asleep === true,
        alias: null,
        includeInstalled: false,
        editors: []
      }
    : null
}

/** Asks before Orca adds its one Include line to ~/.ssh/config for an editor's Remote-SSH. */
const CloudSshIncludeDialog = React.memo(function CloudSshIncludeDialog() {
  const t = useTranslate()
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const workspaceId = typeof modalData.workspaceId === 'string' ? modalData.workspaceId : null
  const editor = useMemo(() => readEditor(modalData.editor), [modalData.editor])
  const status = useMemo(() => readStatus(modalData.status), [modalData.status])
  const includeLine = typeof modalData.includeLine === 'string' ? modalData.includeLine : ''
  const valid = Boolean(workspaceId && editor && status && includeLine)

  useEffect(() => {
    if (!valid) {
      closeModal()
    }
  }, [closeModal, valid])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )
  const handleConfirm = useCallback(() => {
    closeModal()
    if (workspaceId && editor && status) {
      void openCloudWorkspaceInEditor({ workspaceId, editor, status, allowSshConfigInclude: true })
    }
  }, [closeModal, editor, status, workspaceId])

  if (!valid || !editor) {
    return null
  }
  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent surface="security" className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(
              'auto.components.sidebar.CloudSshIncludeDialog.title',
              'Let {{editor}} find your cloud workspaces?',
              { editor: editor.label }
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.sidebar.CloudSshIncludeDialog.body',
              '{{editor}} connects through ~/.ssh/config. Orca will add this line at the top. Nothing else in the file changes.',
              { editor: editor.label }
            )}
          </DialogDescription>
        </DialogHeader>
        <pre className="rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-2xs leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
          {includeLine}
        </pre>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            {t('auto.components.sidebar.CloudSshIncludeDialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleConfirm}>
            {t('auto.components.sidebar.CloudSshIncludeDialog.confirm', 'Add Line and Open')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default CloudSshIncludeDialog
