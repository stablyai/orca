import { useEffect, useMemo, useState } from 'react'
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
import { cn } from '@/lib/utils'

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
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [connectState, setConnectState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const personalKeyUrl = buildLinearPersonalApiKeySettingsUrl(workspace?.organizationUrlKey)
  const workspaceApiUrl = buildLinearWorkspaceApiSettingsUrl(workspace?.organizationUrlKey)
  const submitLabel = connectLabel ?? (workspace ? 'Update access' : 'Connect')

  useEffect(() => {
    if (open) {
      return
    }
    setApiKeyDraft('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

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
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectLinear(apiKey)
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setApiKeyDraft('')
        setConnectState('idle')
        onOpenChange(false)
        onConnected?.()
        return
      }
      setConnectState('error')
      setConnectError(result.error)
    } catch (error) {
      if (mountedRef.current) {
        setConnectState('error')
        setConnectError(error instanceof Error ? error.message : 'Connection failed')
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
      : 'Paste a Personal API key for the Linear workspace you want Orca to use.')
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
          <Input
            autoFocus
            type="password"
            placeholder="lin_api_..."
            value={apiKeyDraft}
            onChange={(event) => {
              setApiKeyDraft(event.target.value)
              if (connectState === 'error') {
                setConnectState('idle')
                setConnectError(null)
              }
            }}
            disabled={connectState === 'connecting'}
          />
          {connectState === 'error' && connectError ? (
            <p className="text-xs text-destructive">{connectError}</p>
          ) : null}
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p>
              Create a Personal API key from Account &gt; Security &amp; Access.{' '}
              {!workspace
                ? 'Use Linear to choose the intended workspace before creating the key.'
                : null}
            </p>
            <p>
              Prefer full access when Orca should show every team the account can access in that
              workspace. Restricted keys only expose permitted teams, and private teams require the
              key owner to have access.
            </p>
            <p>
              If member API keys are blocked, ask a workspace admin to allow them from workspace API
              settings.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                onClick={() => window.api.shell.openUrl(personalKeyUrl)}
              >
                <ExternalLink className="size-3" />
                Personal API keys
              </button>
              <span className="text-muted-foreground/60">|</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                onClick={() => window.api.shell.openUrl(workspaceApiUrl)}
              >
                <ExternalLink className="size-3" />
                Workspace API settings
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
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={connectState === 'connecting'}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleConnect()}
            disabled={!apiKeyDraft.trim() || connectState === 'connecting'}
          >
            {connectState === 'connecting' ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Verifying...
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
