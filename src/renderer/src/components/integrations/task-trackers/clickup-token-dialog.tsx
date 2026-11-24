import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle, Lock } from 'lucide-react'
import {
  taskProviderErrorMessage,
  taskProviderErrorText
} from '@/lib/work-items/task-provider-error-copy'
import { useAppStore } from '@/store/index'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/class-names'
import { preventOutsideDismissWhenDirty } from '@/lib/overlay-interaction/outside-dismiss-guard'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useTranslate } from '@/i18n/use-translate'
import { CLICKUP_APPS_SETTINGS_URL } from '../../../../../shared/clickup/clickup-links'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { getEnvironmentRuntimeIdentityKey } from '@/runtime/hosts/observations/provider-runtime-context'
import {
  closedClickUpTokenDialogState,
  resolveClickUpTokenDialogState
} from './clickup-token-dialog-state'

type ClickUpTokenDialogProps = {
  /** The host that stores the token this dialog saves. */
  owner: RuntimeClientTarget
  open: boolean
  onOpenChange: (open: boolean) => void
  /** True when a saved token exists and this replaces it. */
  reconnect?: boolean
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

export function ClickUpTokenDialog({
  owner,
  open,
  onOpenChange,
  reconnect = false,
  onConnected,
  overlayClassName,
  contentClassName
}: ClickUpTokenDialogProps): React.JSX.Element {
  const t = useTranslate()
  const connectClickUp = useAppStore((s) => s.connectClickUp)
  const mountedRef = useMountedRef()
  const tokenInputId = useId()
  const tokenErrorId = useId()
  // The host, not its session generation: a reconnect of the same host keeps what was typed for it.
  const ownerKey = getEnvironmentRuntimeIdentityKey(runtimeTargetEnvironmentId(owner))
  // Counts owner changes and open/close flips, so a connect from before A to B and back to A, or from before a
  // parent-driven close and reopen, is not mistaken for one of this dialog session.
  const attemptGenerationRef = useRef(0)
  // A layout effect, so a connect that settles right after the commit is already stale.
  useLayoutEffect(() => {
    attemptGenerationRef.current += 1
  }, [ownerKey, open])
  const [dialogState, setDialogState] = useState(() => closedClickUpTokenDialogState(ownerKey))
  const resolvedDialogState = resolveClickUpTokenDialogState(dialogState, open, ownerKey)
  if (resolvedDialogState !== dialogState) {
    // Reset hidden drafts/errors before paint because parent closure can race a connect request.
    setDialogState(resolvedDialogState)
  }
  const { tokenDraft, connectState, connectError } = resolvedDialogState

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }
  // Why: a stray backdrop click must not discard a typed token. Escape / Cancel / × stay explicit.
  const guardOutsideDismiss = preventOutsideDismissWhenDirty(() => tokenDraft !== '')

  const handleConnect = async (): Promise<void> => {
    const token = tokenDraft.trim()
    if (!token || connectState === 'connecting') {
      return
    }
    setDialogState((current) => ({ ...current, connectState: 'connecting', connectError: null }))
    // The dialog may have moved to another owner by the time the request settles; its outcome is not theirs.
    const attemptGeneration = attemptGenerationRef.current
    const isStale = (): boolean =>
      !mountedRef.current || attemptGenerationRef.current !== attemptGeneration
    try {
      const result = await connectClickUp(owner, token)
      if (isStale()) {
        return
      }
      if (result.ok) {
        setDialogState(closedClickUpTokenDialogState(ownerKey))
        onOpenChange(false)
        onConnected?.()
        return
      }
      setDialogState((current) => ({
        ...current,
        connectState: 'error',
        connectError: taskProviderErrorMessage(result)
      }))
    } catch (error) {
      if (!isStale()) {
        setDialogState((current) => ({
          ...current,
          connectState: 'error',
          connectError:
            error instanceof Error
              ? taskProviderErrorText(error.message)
              : t('taskProviders.clickup.connectionFailed', 'Connection failed')
        }))
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-lg', contentClassName)}
        onPointerDownOutside={guardOutsideDismiss}
        onInteractOutside={guardOutsideDismiss}
      >
        <DialogHeader>
          <DialogTitle>
            {reconnect
              ? t('taskProviders.clickup.reconnectTitle', 'Reconnect ClickUp')
              : t('taskProviders.clickup.connectTitle', 'Connect ClickUp')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'taskProviders.clickup.tokenHint',
              'Paste a personal API token. Orca lists your ClickUp tasks, changes their status, adds comments, and starts workspaces linked to them. One token covers every Workspace you belong to.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void handleConnect()
          }}
        >
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={tokenInputId}>
                {t('taskProviders.clickup.tokenLabel', 'Personal API token')}
              </Label>
              <Input
                id={tokenInputId}
                autoFocus
                type="password"
                placeholder={t('taskProviders.clickup.tokenPlaceholder', 'pk_...')}
                value={tokenDraft}
                onChange={(event) => {
                  const nextDraft = event.target.value
                  setDialogState((current) => ({
                    ownerKey: current.ownerKey,
                    tokenDraft: nextDraft,
                    connectState: current.connectState === 'error' ? 'idle' : current.connectState,
                    connectError: current.connectState === 'error' ? null : current.connectError
                  }))
                }}
                disabled={connectState === 'connecting'}
                aria-invalid={connectState === 'error'}
                aria-describedby={connectState === 'error' ? tokenErrorId : undefined}
              />
            </div>
            {connectState === 'error' && connectError ? (
              <p id={tokenErrorId} className="text-xs text-destructive">
                {connectError}
              </p>
            ) : null}
            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                {t(
                  'taskProviders.clickup.tokenSteps',
                  'In ClickUp, open Settings > Apps, then choose Generate under API Token and copy it here.'
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  onClick={(event) => openAppHttpLink(CLICKUP_APPS_SETTINGS_URL, { event })}
                >
                  <ExternalLink className="size-3" />
                  {t('taskProviders.clickup.openAppsSettings', 'ClickUp Settings > Apps')}
                </button>
              </div>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {owner.kind === 'environment'
                ? t(
                    'taskProviders.clickup.remoteTokenStorage',
                    'This token is stored by the active remote runtime.'
                  )
                : t(
                    'taskProviders.clickup.localTokenStorage',
                    'Local runtime tokens are stored on this device using Electron encrypted storage when available.'
                  )}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={connectState === 'connecting'}
            >
              {t('taskProviders.clickup.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!tokenDraft.trim() || connectState === 'connecting'}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {t('taskProviders.clickup.verifying', 'Verifying...')}
                </>
              ) : reconnect ? (
                t('taskProviders.clickup.updateToken', 'Update token')
              ) : (
                t('taskProviders.clickup.connect', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
