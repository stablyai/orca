import React, { useCallback, useEffect, useSyncExternalStore } from 'react'
import { KeyRound, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cloudSecretsErrorCopy } from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import {
  clearCloudSecretsMissing,
  narrowCloudSecretsMissing,
  readCloudSecretsMissing,
  useCloudSecretsMissing
} from '@/lib/orca-cloud/cloud-secrets-missing-notice-store'
import { CloudSecretsAskForm } from './CloudSecretsAskForm'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useCloudSecretsAskLoad } from './use-cloud-secrets-ask'
import { useCloudSecretsAskForm } from './use-cloud-secrets-ask-form'

// One dialog for the whole app, opened from whichever workspace panel asked.
type OpenTarget = { workspaceId: string; repoKey: string }
let openFor: OpenTarget | null = null
const listeners = new Set<() => void>()
function setOpenFor(target: OpenTarget | null): void {
  openFor = target
  for (const listener of listeners) {
    listener()
  }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function openCloudSecretsAsk(workspaceId: string): void {
  const notice = readCloudSecretsMissing(workspaceId)
  if (notice) {
    setOpenFor({ workspaceId, repoKey: notice.repoKey })
  }
}

/** Shown in a cloud workspace's status panel while names it needs are still unfilled. */
export function CloudSecretsMissingNotice({
  workspaceId
}: {
  workspaceId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const notice = useCloudSecretsMissing(workspaceId)
  if (!notice) {
    return null
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1 ps-2.5 pe-1 text-xs"
    >
      <KeyRound aria-hidden className="size-3.5 shrink-0 text-status-warning" />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {t('cloudSecretsAsk.missing', '{{count}} secrets missing', {
          count: notice.names.length,
          defaultValue_one: '{{count}} secret missing'
        })}
      </span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => openCloudSecretsAsk(workspaceId)}
      >
        {t('cloudSecretsAsk.add', 'Add')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('cloudSecretsAsk.dismissNotice', 'Dismiss secrets missing notice')}
        onClick={() => clearCloudSecretsMissing(workspaceId)}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

function CloudSecretsAskDialogBody({
  workspaceId,
  repoKey
}: {
  workspaceId: string
  repoKey: string
}): React.JSX.Element {
  const t = useTranslate()
  // The workspace's runtime environment, so a shared one isn't offered Personal values (SEC-5).
  const runtimeEnvironmentId = useAppStore((state) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(state, workspaceId)
  )
  const { load, reload } = useCloudSecretsAskLoad(repoKey, runtimeEnvironmentId)
  const data = load.status === 'ready' ? load.data : null
  // Filled elsewhere since the sheet closed: the notice follows what is really missing now.
  useEffect(() => {
    if (load.status === 'ready') {
      narrowCloudSecretsMissing(workspaceId, load.data.missing)
    } else if (load.status === 'none') {
      clearCloudSecretsMissing(workspaceId)
    }
  }, [load, workspaceId])
  const onSaved = useCallback(() => reload(), [reload])
  const onSkip = useCallback(() => setOpenFor(null), [])
  const { state, actions } = useCloudSecretsAskForm({
    data,
    refreshRuntimeEnvironmentId: null,
    onSaved,
    onSkip
  })
  if (load.status === 'loading') {
    return (
      <div aria-busy="true" className="flex flex-col gap-2 py-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-full" />
        <span className="sr-only">{t('cloudSecretsAsk.loading', 'Loading secrets…')}</span>
      </div>
    )
  }
  if (load.status === 'failed') {
    return (
      <InlineError
        title={cloudSecretsErrorCopy(load.error, t)}
        retryLabel={t('cloudSecretsAsk.retry', 'Try again')}
        onRetry={reload}
      />
    )
  }
  if (!data) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('cloudSecretsAsk.nothingMissing', 'Nothing is missing.')}
      </p>
    )
  }
  return <CloudSecretsAskForm data={data} state={state} actions={actions} />
}

/** App-level dialog behind the notice's Add. */
export function CloudSecretsAskDialogHost(): React.JSX.Element | null {
  const t = useTranslate()
  const target = useSyncExternalStore(
    subscribe,
    () => openFor,
    () => openFor
  )
  if (!target) {
    return null
  }
  return (
    <Dialog open onOpenChange={(open) => !open && setOpenFor(null)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('cloudSecretsAsk.dialogTitle', 'Add missing secrets')}</DialogTitle>
          <DialogDescription>
            {t(
              'cloudSecretsAsk.dialogDetail',
              'Values go to your Cloud secrets. New terminals and agents in this workspace get them within a few seconds.'
            )}
          </DialogDescription>
        </DialogHeader>
        <CloudSecretsAskDialogBody workspaceId={target.workspaceId} repoKey={target.repoKey} />
      </DialogContent>
    </Dialog>
  )
}
