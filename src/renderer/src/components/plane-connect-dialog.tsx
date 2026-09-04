import { useId, useLayoutEffect, useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'
import { planeConnect } from '@/runtime/runtime-plane-client'
import { useAppStore } from '@/store'
import { buildPlaneConnectArgs } from './plane-connect-args'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
}

type Deployment = 'cloud' | 'self-hosted'

export function PlaneConnectDialog({ open, onOpenChange, onConnected }: Props): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const mountedRef = useMountedRef()
  const slugId = useId()
  const baseUrlId = useId()
  const tokenId = useId()
  const errorId = useId()
  const [deployment, setDeployment] = useState<Deployment>('cloud')
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (open) {
      setDeployment('cloud')
      setWorkspaceSlug('')
      setBaseUrl('')
      setToken('')
      setConnecting(false)
      setError(null)
    }
  }, [open])

  const selfHosted = deployment === 'self-hosted'
  const canSubmit = workspaceSlug.trim() && token.trim() && (!selfHosted || baseUrl.trim())
  const storageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.PlaneConnectDialog.remoteStorage',
        'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.PlaneConnectDialog.localStorage',
        'Your token is stored locally and encrypted when local runtime storage supports it.'
      )

  const connect = async (): Promise<void> => {
    if (!canSubmit || connecting) {
      return
    }
    setConnecting(true)
    setError(null)
    try {
      const result = await planeConnect(
        settings,
        buildPlaneConnectArgs({ selfHosted, baseUrl, workspaceSlug, apiToken: token })
      )
      if (!mountedRef.current) {
        return
      }
      if (!result.ok) {
        setError(result.error)
        return
      }
      onOpenChange(false)
      onConnected?.()
    } catch (cause) {
      if (mountedRef.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : translate('auto.components.PlaneConnectDialog.failed', 'Connection failed')
        )
      }
    } finally {
      if (mountedRef.current) {
        setConnecting(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !connecting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="gap-3">
          <DialogTitle>
            {translate('auto.components.PlaneConnectDialog.title', 'Connect Plane')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.PlaneConnectDialog.description',
              'Use a personal access token and workspace slug to browse Plane work items.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <ToggleGroup
            type="single"
            variant="outline"
            value={deployment}
            disabled={connecting}
            onValueChange={(value) => {
              if (!value) {
                return
              }
              setDeployment(value as Deployment)
              setError(null)
            }}
            aria-label={translate(
              'auto.components.PlaneConnectDialog.deployment',
              'Plane deployment'
            )}
          >
            <ToggleGroupItem value="cloud" className="h-8 px-3 text-xs">
              {translate('auto.components.PlaneConnectDialog.cloud', 'Plane Cloud')}
            </ToggleGroupItem>
            <ToggleGroupItem value="self-hosted" className="h-8 px-3 text-xs">
              {translate('auto.components.PlaneConnectDialog.selfHosted', 'Self-hosted')}
            </ToggleGroupItem>
          </ToggleGroup>
          {selfHosted ? (
            <div className="space-y-2">
              <Label htmlFor={baseUrlId}>
                {translate('auto.components.PlaneConnectDialog.baseUrl', 'Base URL')}
              </Label>
              <Input
                id={baseUrlId}
                autoFocus
                placeholder={translate(
                  'auto.components.PlaneConnectDialog.baseUrlPlaceholder',
                  'https://plane.example.com'
                )}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value)
                  setError(null)
                }}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={slugId}>
              {translate('auto.components.PlaneConnectDialog.workspaceSlug', 'Workspace slug')}
            </Label>
            <Input
              id={slugId}
              autoFocus={!selfHosted}
              placeholder={translate('auto.components.PlaneConnectDialog.slugPlaceholder', 'acme')}
              value={workspaceSlug}
              onChange={(event) => {
                setWorkspaceSlug(event.target.value)
                setError(null)
              }}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.PlaneConnectDialog.slugHelp',
                'The slug is the first path segment in your Plane app URL.'
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={tokenId}>
              {translate('auto.components.PlaneConnectDialog.token', 'Personal access token')}
            </Label>
            <Input
              id={tokenId}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
                setError(null)
              }}
              aria-describedby={error ? errorId : undefined}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.PlaneConnectDialog.tokenHelp',
                'Create one in Plane → Profile settings → Personal access tokens.'
              )}
            </p>
          </div>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <p>{storageCopy}</p>
          </div>
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={connecting}
            >
              {translate('auto.components.PlaneConnectDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit || connecting}>
              {connecting ? (
                <>
                  <Loader2 className="animate-spin" />
                  {translate('auto.components.PlaneConnectDialog.connecting', 'Connecting…')}
                </>
              ) : (
                translate('auto.components.PlaneConnectDialog.connect', 'Connect Plane')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
