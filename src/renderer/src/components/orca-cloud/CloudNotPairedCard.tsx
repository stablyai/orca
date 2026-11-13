// The waking overlay's card when this computer's pairing to a cloud workspace is gone: nothing here
// can wake it, so instead of Try again it offers "Open cloud workspace…", which pairs it again.
import React from 'react'
import { AlertTriangle, Cloud, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudWorkspacePicker } from '@/components/cloud-workspaces/cloud-workspace-picker-store'

export function CloudNotPairedCard({
  name,
  autoFocus = true,
  onDismiss
}: {
  name: string
  autoFocus?: boolean
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="alert"
      data-cloud-not-paired-card=""
      className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium">
            {t('orcaCloudWorkspace.notPaired.title', '{{name}} isn’t linked to this computer', {
              name
            })}
          </div>
          <p className="break-words text-xs text-foreground">
            {t(
              'orcaCloudWorkspace.notPaired.body',
              'Open it again to link it. Your files and chats are saved.'
            )}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="quiet"
          className="-mt-1 -mr-1"
          aria-label={t('orcaCloudWorkspace.dismiss', 'Dismiss')}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          autoFocus={autoFocus}
          onClick={() => {
            onDismiss()
            openCloudWorkspacePicker()
          }}
        >
          <Cloud aria-hidden />
          {t('components.cloudWorkspaces.picker.menuItem', 'Open cloud workspace…')}
        </Button>
      </div>
    </div>
  )
}
