import React, { useCallback } from 'react'
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
import { dirname } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import type { WorkspaceTrustPromptDecision } from '@/lib/ensure-workspace-trust-confirmed'

/**
 * The renderer's one and only workspace-trust prompt surface — opened by
 * `ensureWorkspaceTrustConfirmed` for every intake path (repo add, clone, folder workspace).
 * States the exact path, that trust inherits to everything nested beneath it, and which
 * capability is affected, and offers trusting the parent as an explicit alternative
 * (Req: Prompt Discloses Path, Inheritance, and Effect).
 */
const WorkspaceTrustPromptDialog = React.memo(function WorkspaceTrustPromptDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)

  const isOpen = activeModal === 'confirm-workspace-trust'
  const path = typeof modalData.path === 'string' ? modalData.path : ''
  const parentPath = path ? dirname(path) : ''
  const onResolve =
    typeof modalData.onResolve === 'function'
      ? (modalData.onResolve as (decision: WorkspaceTrustPromptDecision) => void)
      : null

  const resolveAndClose = useCallback(
    (decision: WorkspaceTrustPromptDecision) => {
      onResolve?.(decision)
      closeModal()
    },
    [closeModal, onResolve]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        resolveAndClose('decline')
      }
    },
    [resolveAndClose]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.sidebar.WorkspaceTrustPromptDialog.title',
              'Trust this location?'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.WorkspaceTrustPromptDialog.body',
              '{{path}} is not trusted yet. Trusting it lets Orca run local tools scoped to this folder — such as reading package details from your local npm client — and the decision applies to everything nested beneath it too.',
              { path }
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          <Button
            variant="outline"
            size="sm"
            onClick={() => resolveAndClose('trust-parent')}
            className="justify-start"
          >
            {translate(
              'auto.components.sidebar.WorkspaceTrustPromptDialog.trustParent',
              'Trust {{parentPath}} instead',
              { parentPath }
            )}
          </Button>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => resolveAndClose('decline')}>
              {translate(
                'auto.components.sidebar.WorkspaceTrustPromptDialog.decline',
                "Don't trust"
              )}
            </Button>
            <Button size="sm" onClick={() => resolveAndClose('trust-workspace')}>
              {translate(
                'auto.components.sidebar.WorkspaceTrustPromptDialog.trustWorkspace',
                'Trust this location'
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default WorkspaceTrustPromptDialog
