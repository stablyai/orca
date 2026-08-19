import React from 'react'
import { BaseRefPicker } from '@/components/settings/BaseRefPicker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { FolderBaseRefEditor } from './folder-source-control-actions'
import type { FolderGitTarget } from './folder-source-control-repos'

/** Lets users change the compare base ref for a folder-scope repo. */
export function FolderSourceControlBaseRefDialog({
  open,
  onOpenChange,
  target,
  currentBaseRef,
  onSelect,
  onUsePrimary
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: FolderGitTarget
  currentBaseRef: string | undefined
  onSelect: (ref: string) => void
  onUsePrimary?: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(85vh,36rem)] max-w-xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm">
            {translate('auto.components.right.sidebar.SourceControl.476b77745b', 'Change Base Ref')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.right.sidebar.SourceControl.c9ad22888e',
              'Pick the branch compare target for this repository.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto scrollbar-sleek">
          {target.repo ? (
            <BaseRefPicker
              repoId={target.repo.id}
              hostId={target.executionHostId ?? undefined}
              currentBaseRef={currentBaseRef}
              onSelect={onSelect}
              onUsePrimary={onUsePrimary}
            />
          ) : (
            <FolderBaseRefEditor value={currentBaseRef ?? ''} onApply={onSelect} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
