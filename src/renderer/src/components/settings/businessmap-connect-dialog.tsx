import { useId, useLayoutEffect, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
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
import { preventOutsideDismissWhenDirty } from '@/lib/outside-dismiss-guard'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import type { BusinessmapDomain } from '../../../../shared/businessmap-types'
import { translate } from '@/i18n/i18n'

// Validated client-side before submit; the API rejects anything else.
export const BUSINESSMAP_SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/i

type BusinessmapConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
}

type ConnectState = 'idle' | 'connecting' | 'error'

// Why: mirrors the Jira connect dialog so the Tasks setup flow can reuse the
// same subdomain + API key flow without depending on another surface's state.
export function BusinessmapConnectDialog({
  open,
  onOpenChange,
  onConnected
}: BusinessmapConnectDialogProps): React.JSX.Element {
  const connectBusinessmap = useAppStore((s) => s.connectBusinessmap)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const subdomainId = useId()
  const apiKeyId = useId()
  const errorId = useId()

  const [subdomain, setSubdomain] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [domain, setDomain] = useState<BusinessmapDomain>('businessmap.io')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Start every open with a clean slate so a previously-typed secret, stale
  // domain selection, or old error can't linger across reopens.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setSubdomain('')
    setApiKey('')
    setDomain('businessmap.io')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const subdomainValid = BUSINESSMAP_SUBDOMAIN_PATTERN.test(subdomain.trim())
  const canSubmit = subdomainValid && Boolean(apiKey.trim()) && connectState !== 'connecting'
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.businessmap.connect.dialog.remoteStorage',
        'Your API key is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.businessmap.connect.dialog.localStorage',
        'Your API key is stored locally and encrypted when local runtime storage supports it.'
      )

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  // Why: a stray backdrop click must not discard typed credentials. Escape / Cancel / × stay explicit.
  const isDraftDirty = (): boolean => subdomain !== '' || apiKey !== ''
  const guardOutsideDismiss = preventOutsideDismissWhenDirty(isDraftDirty)

  const handleConnect = async (): Promise<void> => {
    const trimmedSubdomain = subdomain.trim()
    const trimmedKey = apiKey.trim()
    if (
      !BUSINESSMAP_SUBDOMAIN_PATTERN.test(trimmedSubdomain) ||
      !trimmedKey ||
      connectState === 'connecting'
    ) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectBusinessmap({
        subdomain: trimmedSubdomain,
        apiKey: trimmedKey,
        domain
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setSubdomain('')
        setApiKey('')
        setDomain('businessmap.io')
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={guardOutsideDismiss}
        onInteractOutside={guardOutsideDismiss}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.businessmap.connect.dialog.title', 'Connect Businessmap')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.businessmap.connect.dialog.description',
              'Use your Businessmap subdomain and API key to browse cards.'
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
          <div className="flex flex-col gap-3">
            <div className="space-y-2">
              <Label htmlFor={subdomainId}>
                {translate('auto.components.businessmap.connect.dialog.subdomain', 'Subdomain')}
              </Label>
              <Input
                id={subdomainId}
                autoFocus
                placeholder={translate(
                  'auto.components.businessmap.connect.dialog.subdomainPlaceholder',
                  'acme'
                )}
                value={subdomain}
                onChange={(event) => {
                  setSubdomain(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
                aria-invalid={subdomain !== '' && !subdomainValid}
              />
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              value={domain}
              disabled={connectState === 'connecting'}
              onValueChange={(value: string) => {
                if (connectState === 'connecting') {
                  return
                }
                if (value === 'businessmap.io' || value === 'kanbanize.com') {
                  setDomain(value)
                }
                clearErrorOnEdit()
              }}
              aria-label={translate(
                'auto.components.businessmap.connect.dialog.domain',
                'Businessmap domain'
              )}
            >
              <ToggleGroupItem value="businessmap.io" size="sm">
                businessmap.io
              </ToggleGroupItem>
              <ToggleGroupItem value="kanbanize.com" size="sm">
                kanbanize.com
              </ToggleGroupItem>
            </ToggleGroup>
            <div className="space-y-2">
              <Label htmlFor={apiKeyId}>
                {translate('auto.components.businessmap.connect.dialog.apiKey', 'API key')}
              </Label>
              <Input
                id={apiKeyId}
                type="password"
                placeholder={translate(
                  'auto.components.businessmap.connect.dialog.apiKeyPlaceholder',
                  'Businessmap API key'
                )}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
                aria-invalid={connectState === 'error'}
                aria-describedby={connectState === 'error' ? errorId : undefined}
              />
            </div>
            {connectState === 'error' && connectError ? (
              <p id={errorId} className="text-xs text-destructive">
                {connectError}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.businessmap.connect.dialog.help',
                'Create an API key in Businessmap under Account Settings > API.'
              )}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {credentialStorageCopy}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={connectState === 'connecting'}
            >
              {translate('auto.components.businessmap.connect.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.businessmap.connect.dialog.verifying', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.businessmap.connect.dialog.connect', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
