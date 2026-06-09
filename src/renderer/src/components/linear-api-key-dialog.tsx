import { useId, useMemo, useState } from 'react'
import { ExternalLink, LoaderCircle, Lock } from 'lucide-react'
import type { LinearWorkspace } from '../../../shared/types'
import {
  buildLinearPersonalApiKeySettingsUrl,
  buildLinearWorkspaceApiSettingsUrl
} from '../../../shared/linear-links'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
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
import { cn } from '@/lib/utils'
import {
  createLinearApiKeyDialogState,
  resolveLinearApiKeyDialogState
} from './linear-api-key-dialog-state'
import { translate } from '@/i18n/i18n'

type LinearApiKeyDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: LinearWorkspace | null
  title?: string
  description?: string
  connectLabel?: string
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

export function LinearApiKeyDialog({
  open,
  onOpenChange,
  workspace,
  title,
  description,
  connectLabel,
  onConnected,
  overlayClassName,
  contentClassName
}: LinearApiKeyDialogProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const connectLinear = useAppStore((s) => s.connectLinear)
  const mountedRef = useMountedRef()
  const apiKeyInputId = useId()
  const apiKeyErrorId = useId()
  const [dialogState, setDialogState] = useState(createLinearApiKeyDialogState)

  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const personalKeyUrl = buildLinearPersonalApiKeySettingsUrl(workspace?.organizationUrlKey)
  const workspaceApiUrl = buildLinearWorkspaceApiSettingsUrl(workspace?.organizationUrlKey)
  const submitLabel = connectLabel ?? (workspace ? 'Update access' : 'Connect')
  const resolvedDialogState = resolveLinearApiKeyDialogState(dialogState, open)
  if (resolvedDialogState !== dialogState) {
    // Why: parent-controlled close can race an in-flight connect request; keep
    // hidden draft/error state reset before the next open paints.
    setDialogState(resolvedDialogState)
  }
  const { apiKeyDraft, connectState, connectError } = resolvedDialogState

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  const handleConnect = async (): Promise<void> => {
    const apiKey = apiKeyDraft.trim()
    if (!apiKey || connectState === 'connecting') {
      return
    }
    setDialogState((current) => ({ ...current, connectState: 'connecting', connectError: null }))
    try {
      const result = await connectLinear(apiKey)
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setDialogState(createLinearApiKeyDialogState())
        onOpenChange(false)
        onConnected?.()
        return
      }
      setDialogState((current) => ({
        ...current,
        connectState: 'error',
        connectError: result.error
      }))
    } catch (error) {
      if (mountedRef.current) {
        setDialogState((current) => ({
          ...current,
          connectState: 'error',
          connectError: error instanceof Error ? error.message : 'Connection failed'
        }))
      }
    }
  }

  const resolvedTitle =
    title ??
    (workspace ? `Update Linear access for ${workspace.organizationName}` : 'Add Linear access')
  const resolvedDescription =
    description ??
    (workspace
      ? `Paste a Personal API key for ${workspace.organizationName}. If this workspace is already connected, Orca replaces its stored key.`
      : 'Paste a Personal API key for the Linear workspace you want Orca to use. If that workspace is already connected, Orca replaces its stored key.')
  const storageCopy =
    runtimeTarget.kind === 'environment'
      ? 'This key is stored by the active remote runtime.'
      : 'Local runtime keys are stored on this device using Electron encrypted storage when available.'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-lg', contentClassName)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && apiKeyDraft.trim() && connectState !== 'connecting') {
            event.preventDefault()
            void handleConnect()
          }
        }}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">{resolvedTitle}</DialogTitle>
          <DialogDescription>{resolvedDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={apiKeyInputId} className="text-xs">
              {translate('auto.components.linear.api.key.dialog.7d498f653c', 'Personal API key')}
            </Label>
            <Input
              id={apiKeyInputId}
              autoFocus
              type="password"
              placeholder={translate(
                'auto.components.linear.api.key.dialog.edec49dfae',
                'lin_api_...'
              )}
              value={apiKeyDraft}
              onChange={(event) => {
                const nextDraft = event.target.value
                setDialogState((current) => ({
                  apiKeyDraft: nextDraft,
                  connectState: current.connectState === 'error' ? 'idle' : current.connectState,
                  connectError: current.connectState === 'error' ? null : current.connectError
                }))
              }}
              disabled={connectState === 'connecting'}
              aria-invalid={connectState === 'error'}
              aria-describedby={connectState === 'error' ? apiKeyErrorId : undefined}
            />
          </div>
          {connectState === 'error' && connectError ? (
            <p id={apiKeyErrorId} className="text-xs text-destructive">
              {connectError}
            </p>
          ) : null}
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p>
              {translate(
                'auto.components.linear.api.key.dialog.af52a6227f',
                'Create a Personal API key from Account > Security & Access.'
              )}{' '}
              {!workspace
                ? translate(
                    'auto.components.linear.api.key.dialog.c9889a09f8',
                    'Use Linear to choose the intended workspace before creating the key.'
                  )
                : null}
            </p>
            <p>
              {translate(
                'auto.components.linear.api.key.dialog.d56d3629f4',
                'Prefer full access when Orca should show every team the account can access in that workspace. Restricted keys only expose permitted teams, and private teams require the key owner to have access.'
              )}
            </p>
            <p>
              {translate(
                'auto.components.linear.api.key.dialog.e3100b36b9',
                'If member API keys are blocked, ask a workspace admin to allow them from workspace API settings.'
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                onClick={() => window.api.shell.openUrl(personalKeyUrl)}
              >
                <ExternalLink className="size-3" />
                {translate('auto.components.linear.api.key.dialog.dc7ccb0f7c', 'Personal API keys')}
              </button>
              <span className="text-muted-foreground/60">|</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                onClick={() => window.api.shell.openUrl(workspaceApiUrl)}
              >
                <ExternalLink className="size-3" />
                {translate(
                  'auto.components.linear.api.key.dialog.e603ee9156',
                  'Workspace API settings'
                )}
              </button>
            </div>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Lock className="size-3 shrink-0" />
            {storageCopy}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={connectState === 'connecting'}
          >
            {translate('auto.components.linear.api.key.dialog.f8f704a019', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleConnect()}
            disabled={!apiKeyDraft.trim() || connectState === 'connecting'}
          >
            {connectState === 'connecting' ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate('auto.components.linear.api.key.dialog.834a52c084', 'Verifying...')}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
