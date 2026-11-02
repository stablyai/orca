import { useId, useLayoutEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, Lock } from 'lucide-react'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { buildPlaneApiTokensUrl } from '../../../shared/plane/links'
import type { PlaneAuthType } from '../../../shared/plane-types'
import { translate } from '@/i18n/i18n'

type PlaneConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

export function PlaneConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: PlaneConnectDialogProps): React.JSX.Element {
  const connectPlane = useAppStore((s) => s.connectPlane)
  const mountedRef = useMountedRef()
  const instanceUrlId = useId()
  const tokenId = useId()
  const errorId = useId()

  const [instanceType, setInstanceType] = useState<PlaneAuthType>('cloud')
  const [instanceUrl, setInstanceUrl] = useState('https://api.plane.so')
  const [apiToken, setApiToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setInstanceType('cloud')
    setInstanceUrl('https://api.plane.so')
    setApiToken('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const isCloud = instanceType === 'cloud'
  const canSubmit =
    Boolean(instanceUrl.trim()) && Boolean(apiToken.trim()) && connectState !== 'connecting'

  const apiTokensUrl = buildPlaneApiTokensUrl(
    isCloud ? 'https://app.plane.so' : instanceUrl || 'https://app.plane.so'
  )

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const handleInstanceTypeChange = (type: string): void => {
    if (type === 'cloud' || type === 'self_hosted') {
      setInstanceType(type)
      if (type === 'cloud') {
        setInstanceUrl('https://api.plane.so')
      } else if (instanceUrl === 'https://api.plane.so') {
        setInstanceUrl('')
      }
      clearErrorOnEdit()
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  const handleConnect = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)

    try {
      const result = await connectPlane({
        instanceType,
        instanceUrl: instanceUrl.trim(),
        apiToken: apiToken.trim()
      })

      if (!mountedRef.current) {
        return
      }

      if (result.ok) {
        setConnectState('idle')
        onOpenChange(false)
        onConnected?.()
        return
      }

      setConnectState('error')
      setConnectError(result.error)
    } catch (error) {
      if (mountedRef.current) {
        const message = error instanceof Error ? error.message : 'Failed to connect'
        setConnectState('error')
        setConnectError(message)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={contentClassName ?? 'sm:max-w-[460px]'}
        aria-describedby="plane-connect-dialog-description"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
            Connect Plane
          </DialogTitle>
          <DialogDescription id="plane-connect-dialog-description">
            Connect your Plane workspace to browse issues and open worktrees with ticket context.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            void handleConnect()
          }}
        >
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">Deployment Type</Label>
            <ToggleGroup
              type="single"
              value={instanceType}
              onValueChange={handleInstanceTypeChange}
              className="grid w-full grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-1"
            >
              <ToggleGroupItem
                value="cloud"
                className="h-8 text-xs font-medium data-[state=on]:bg-background data-[state=on]:shadow-sm"
              >
                Plane Cloud
              </ToggleGroupItem>
              <ToggleGroupItem
                value="self_hosted"
                className="h-8 text-xs font-medium data-[state=on]:bg-background data-[state=on]:shadow-sm"
              >
                Self-Hosted
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {!isCloud && (
            <div className="space-y-1.5">
              <Label htmlFor={instanceUrlId} className="text-xs font-medium">
                Instance URL
              </Label>
              <Input
                id={instanceUrlId}
                type="url"
                value={instanceUrl}
                onChange={(e) => {
                  setInstanceUrl(e.target.value)
                  clearErrorOnEdit()
                }}
                placeholder="https://plane.yourcompany.com"
                disabled={connectState === 'connecting'}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor={tokenId} className="text-xs font-medium">
                Personal API Token
              </Label>
              <a
                href={apiTokensUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                Create API Token
                <ExternalLink className="size-3" />
              </a>
            </div>
            <Input
              id={tokenId}
              type="password"
              value={apiToken}
              onChange={(e) => {
                setApiToken(e.target.value)
                clearErrorOnEdit()
              }}
              placeholder="plane_api_..."
              disabled={connectState === 'connecting'}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {connectError && (
            <div
              id={errorId}
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {connectError}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={connectState === 'connecting'}
            >
              {translate('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                'Connect'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
