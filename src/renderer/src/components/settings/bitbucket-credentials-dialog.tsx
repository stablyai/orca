import { useId, useLayoutEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, Lock } from 'lucide-react'
import type { BitbucketAuthMode } from '../../../../shared/bitbucket-credentials'
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
import { cn } from '@/lib/utils'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'

const API_TOKEN_DOCS_URL = 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/'

type ConnectState = 'idle' | 'connecting' | 'error'

type BitbucketCredentialsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Latest stored metadata, used to prefill the non-secret fields when editing. */
  initialAuthMode?: BitbucketAuthMode | null
  initialEmail?: string | null
  initialBaseUrl?: string | null
  /** Env vars win over stored credentials, so saving here would have no effect. */
  environmentManaged?: boolean
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

export function BitbucketCredentialsDialog({
  open,
  onOpenChange,
  initialAuthMode,
  initialEmail,
  initialBaseUrl,
  environmentManaged = false,
  onConnected,
  overlayClassName,
  contentClassName
}: BitbucketCredentialsDialogProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const emailId = useId()
  const apiTokenId = useId()
  const accessTokenId = useId()
  const baseUrlId = useId()
  const errorId = useId()

  const [authMode, setAuthMode] = useState<BitbucketAuthMode>('basic')
  const [email, setEmail] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Re-sync from the latest stored metadata on every open, not just on mount, so
  // the Edit flow never shows values from a previous connection. Secrets always
  // start empty: the main process never hands them back.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setAuthMode(initialAuthMode ?? 'basic')
    setEmail(initialEmail ?? '')
    setBaseUrl(initialBaseUrl ?? '')
    setApiToken('')
    setAccessToken('')
    setConnectState('idle')
    setConnectError(null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on `open` alone: a status refresh mid-edit must not overwrite what the user is typing.
  }, [open])

  const remoteRuntime = hasRemoteProviderRuntime(settings)
  // Why: only an env-managed connection makes saving pointless. A remote runtime
  // just means the credential is stored on this machine, so the form stays
  // usable and only the storage note changes (matching the Jira dialog).
  const locked = environmentManaged
  const connecting = connectState === 'connecting'
  const isTokenMode = authMode === 'token'
  const hasRequiredFields = isTokenMode
    ? Boolean(accessToken.trim())
    : Boolean(email.trim()) && Boolean(apiToken.trim())
  const canSubmit = !locked && !connecting && hasRequiredFields

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!connecting) {
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
      const result = await window.api.bitbucket.connect({
        authMode,
        accessToken: isTokenMode ? accessToken.trim() : null,
        email: isTokenMode ? null : email.trim(),
        apiToken: isTokenMode ? null : apiToken.trim(),
        baseUrl: baseUrl.trim() || null
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setApiToken('')
        setAccessToken('')
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
        setConnectError(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.bitbucket.credentials.dialog.connectFailed',
                'Connection failed'
              )
        )
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-lg', contentClassName)}
        onKeyDown={(event) => {
          // Only from a text field: Enter on Cancel or the docs link must do
          // what that control does, not submit the form.
          if (!(event.target instanceof HTMLInputElement)) {
            return
          }
          if (event.key === 'Enter' && canSubmit) {
            event.preventDefault()
            void handleConnect()
          }
        }}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {translate(
              'auto.components.settings.bitbucket.credentials.dialog.title',
              'Connect Bitbucket'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.bitbucket.credentials.dialog.description',
              'Use a Bitbucket Cloud credential to browse pull requests and build statuses. Orca verifies it before saving.'
            )}
          </DialogDescription>
        </DialogHeader>
        {locked ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.bitbucket.credentials.dialog.environmentManaged',
              'Bitbucket is already configured through ORCA_BITBUCKET_* environment variables, which take precedence. Unset them to save a credential in Orca.'
            )}
          </p>
        ) : (
          <div className="space-y-3">
            <ToggleGroup
              type="single"
              variant="outline"
              value={authMode}
              disabled={connecting}
              onValueChange={(value) => {
                if (!value || connecting) {
                  return
                }
                setAuthMode(value as BitbucketAuthMode)
                // An API token and an access token are different secrets; drop
                // the typed one so it can't be submitted as the other.
                setApiToken('')
                setAccessToken('')
                clearErrorOnEdit()
              }}
              aria-label={translate(
                'auto.components.settings.bitbucket.credentials.dialog.authModeLabel',
                'Bitbucket authentication method'
              )}
            >
              <ToggleGroupItem value="basic" className="h-8 px-3 text-xs">
                {translate(
                  'auto.components.settings.bitbucket.credentials.dialog.modeBasic',
                  'Email & API token'
                )}
              </ToggleGroupItem>
              <ToggleGroupItem value="token" className="h-8 px-3 text-xs">
                {translate(
                  'auto.components.settings.bitbucket.credentials.dialog.modeToken',
                  'Access token'
                )}
              </ToggleGroupItem>
            </ToggleGroup>
            {isTokenMode ? (
              <div className="space-y-2">
                <Label htmlFor={accessTokenId} className="text-xs">
                  {translate(
                    'auto.components.settings.bitbucket.credentials.dialog.accessToken',
                    'Access token'
                  )}
                </Label>
                <Input
                  id={accessTokenId}
                  autoFocus
                  type="password"
                  placeholder={translate(
                    'auto.components.settings.bitbucket.credentials.dialog.accessTokenPlaceholder',
                    'Repository, project, or workspace access token'
                  )}
                  value={accessToken}
                  onChange={(event) => {
                    setAccessToken(event.target.value)
                    clearErrorOnEdit()
                  }}
                  disabled={connecting}
                  aria-invalid={connectState === 'error'}
                  aria-describedby={connectState === 'error' ? errorId : undefined}
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor={emailId} className="text-xs">
                    {translate(
                      'auto.components.settings.bitbucket.credentials.dialog.email',
                      'Atlassian account email'
                    )}
                  </Label>
                  <Input
                    id={emailId}
                    autoFocus
                    type="email"
                    placeholder={translate(
                      'auto.components.settings.bitbucket.credentials.dialog.emailPlaceholder',
                      'you@example.com'
                    )}
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      clearErrorOnEdit()
                    }}
                    disabled={connecting}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={apiTokenId} className="text-xs">
                    {translate(
                      'auto.components.settings.bitbucket.credentials.dialog.apiToken',
                      'API token'
                    )}
                  </Label>
                  <Input
                    id={apiTokenId}
                    type="password"
                    placeholder={translate(
                      'auto.components.settings.bitbucket.credentials.dialog.apiTokenPlaceholder',
                      'Atlassian API token'
                    )}
                    value={apiToken}
                    onChange={(event) => {
                      setApiToken(event.target.value)
                      clearErrorOnEdit()
                    }}
                    disabled={connecting}
                    aria-invalid={connectState === 'error'}
                    aria-describedby={connectState === 'error' ? errorId : undefined}
                  />
                </div>
              </>
            )}
            <div className="space-y-2">
              <Label htmlFor={baseUrlId} className="text-xs">
                {translate(
                  'auto.components.settings.bitbucket.credentials.dialog.baseUrl',
                  'API base URL (optional)'
                )}
              </Label>
              <Input
                id={baseUrlId}
                placeholder={translate(
                  'auto.components.settings.bitbucket.credentials.dialog.baseUrlPlaceholder',
                  'https://api.bitbucket.org/2.0'
                )}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connecting}
              />
            </div>
            {connectState === 'error' && connectError ? (
              <p id={errorId} className="text-xs text-destructive">
                {connectError}
              </p>
            ) : null}
            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                {isTokenMode
                  ? translate(
                      'auto.components.settings.bitbucket.credentials.dialog.tokenHint',
                      'Repository, project, and workspace access tokens are created from the matching Bitbucket settings page and need read access to pull requests.'
                    )
                  : translate(
                      'auto.components.settings.bitbucket.credentials.dialog.basicHint',
                      'Create an Atlassian API token for your account, then pair it with the email address that owns it.'
                    )}
              </p>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                onClick={() => window.api.shell.openUrl(API_TOKEN_DOCS_URL)}
              >
                <ExternalLink className="size-3" />
                {translate(
                  'auto.components.settings.bitbucket.credentials.dialog.docsLink',
                  'Bitbucket API token docs'
                )}
              </button>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 mt-0.5 shrink-0" />
              {remoteRuntime
                ? translate(
                    'auto.components.settings.bitbucket.credentials.dialog.remoteRuntime',
                    'Stored on this machine, not on the active remote runtime — set ORCA_BITBUCKET_* there instead. Environment variables always take precedence over what you save here.'
                  )
                : translate(
                    'auto.components.settings.bitbucket.credentials.dialog.storageNote',
                    'Stored on this machine with encrypted storage when the OS keychain is available. ORCA_BITBUCKET_* environment variables always take precedence over what you save here.'
                  )}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={connecting}>
            {translate('auto.components.settings.bitbucket.credentials.dialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void handleConnect()} disabled={!canSubmit}>
            {connecting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate(
                  'auto.components.settings.bitbucket.credentials.dialog.verifying',
                  'Verifying...'
                )}
              </>
            ) : (
              translate('auto.components.settings.bitbucket.credentials.dialog.connect', 'Connect')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
