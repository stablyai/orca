import { useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { BitbucketAuthMode } from '../../../../../shared/bitbucket/bitbucket-credentials'
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
import { DialogCancel, DialogDisclosure, DialogError } from '@/components/ui/dialog-parts'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { bitbucketConnect } from '@/runtime/source-control/bitbucket/runtime-bitbucket-credentials-client'
import { preventOutsideDismissWhenDirty } from '@/lib/overlay-interaction/outside-dismiss-guard'
import { bitbucketConnectErrorText } from '@/lib/source-control/remote/bitbucket-connect-error-copy'
import { useTranslate } from '@/i18n/use-translate'
import { BitbucketApiTokenScopes } from './bitbucket-api-token-scopes'

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
  /** The host the card shows; secrets go only there, never to another host. */
  target: RuntimeClientTarget
  onConnected?: () => void
  overlayClassName?: string
}

export function BitbucketCredentialsDialog({
  open,
  onOpenChange,
  initialAuthMode,
  initialEmail,
  initialBaseUrl,
  environmentManaged = false,
  target,
  onConnected,
  overlayClassName
}: BitbucketCredentialsDialogProps): React.JSX.Element {
  const t = useTranslate()
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
  // Capture opening values for dirty checks; status refreshes may replace seed props mid-edit.
  const baselineRef = useRef({ email: '', baseUrl: '' })

  // Reseed stored metadata on each opening; secrets always start empty because main never returns them.
  // Why an event: keyed on `open` alone, so a status refresh mid-edit must not overwrite typing.
  const seedFromStoredMetadata = useEffectEvent(() => {
    const seedEmail = initialEmail ?? ''
    const seedBaseUrl = initialBaseUrl ?? ''
    baselineRef.current = { email: seedEmail, baseUrl: seedBaseUrl }
    setAuthMode(initialAuthMode ?? 'basic')
    setEmail(seedEmail)
    setBaseUrl(seedBaseUrl)
    setApiToken('')
    setAccessToken('')
    setConnectState('idle')
    setConnectError(null)
  })
  useLayoutEffect(() => {
    if (open) {
      seedFromStoredMetadata()
    }
  }, [open])

  const remoteRuntime = target.kind === 'environment'
  // Only environment-managed auth makes saving ineffective; remote runtimes change storage guidance, not form usability.
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

  // Guard accidental backdrop discard using only submitted-mode fields; Escape/Cancel/close remain explicit exits.
  const isDraftDirty = (): boolean =>
    baseUrl !== baselineRef.current.baseUrl ||
    (isTokenMode ? accessToken !== '' : email !== baselineRef.current.email || apiToken !== '')
  const guardOutsideDismiss = preventOutsideDismissWhenDirty(isDraftDirty)

  const handleConnect = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await bitbucketConnect(target, {
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
      setConnectError(bitbucketConnectErrorText(result))
    } catch (error) {
      if (mountedRef.current) {
        setConnectState('error')
        setConnectError(
          error instanceof Error
            ? error.message
            : t(
                'auto.components.settings.bitbucket.credentials.dialog.connectFailed',
                'Connection failed'
              )
        )
      }
    }
  }

  const docsLink = (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-sm text-xs font-normal text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => window.api.shell.openUrl(API_TOKEN_DOCS_URL)}
    >
      {t('components.settings.bitbucket.credentials.dialog.createToken', 'Create one')}
      <ExternalLink className="size-3" aria-hidden="true" />
    </button>
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="form"
        scrollable
        busy={connecting}
        overlayClassName={overlayClassName}
        onPointerDownOutside={guardOutsideDismiss}
        onInteractOutside={guardOutsideDismiss}
        onKeyDown={(event) => {
          // Intercept Enter only in inputs; Cancel and documentation links retain their own actions.
          if (!(event.target instanceof HTMLInputElement)) {
            return
          }
          if (event.key === 'Enter' && canSubmit) {
            event.preventDefault()
            void handleConnect()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.bitbucket.credentials.dialog.title', 'Connect Bitbucket')}
          </DialogTitle>
          {locked ? (
            <DialogDescription>
              {t(
                'components.settings.bitbucket.credentials.dialog.environmentManagedLine',
                'Set by ORCA_BITBUCKET_* environment variables. Unset them to save one here.'
              )}
            </DialogDescription>
          ) : remoteRuntime ? (
            <DialogDescription>
              {t(
                'components.settings.bitbucket.credentials.dialog.savedOnSelectedServer',
                'Sent to the selected server and stored there, encrypted when it supports it.'
              )}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {locked ? null : (
          <div className="flex min-w-0 flex-col gap-3">
            <ToggleGroup
              type="single"
              variant="outline"
              className="w-fit"
              value={authMode}
              disabled={connecting}
              onValueChange={(value) => {
                if (!value || connecting) {
                  return
                }
                setAuthMode(value as BitbucketAuthMode)
                // Drop secrets on mode changes so API tokens cannot be submitted as access tokens or vice versa.
                setApiToken('')
                setAccessToken('')
                clearErrorOnEdit()
              }}
              aria-label={t(
                'auto.components.settings.bitbucket.credentials.dialog.authModeLabel',
                'Bitbucket authentication method'
              )}
            >
              <ToggleGroupItem value="basic" className="h-8 px-3 text-xs">
                {t(
                  'auto.components.settings.bitbucket.credentials.dialog.modeBasic',
                  'Email & API token'
                )}
              </ToggleGroupItem>
              <ToggleGroupItem value="token" className="h-8 px-3 text-xs">
                {t(
                  'auto.components.settings.bitbucket.credentials.dialog.modeToken',
                  'Access token'
                )}
              </ToggleGroupItem>
            </ToggleGroup>
            {isTokenMode ? (
              <div className="grid gap-1.5">
                <Label htmlFor={accessTokenId} variant="dialog-field">
                  {t(
                    'auto.components.settings.bitbucket.credentials.dialog.accessToken',
                    'Access token'
                  )}
                </Label>
                <Input
                  id={accessTokenId}
                  autoFocus
                  type="password"
                  placeholder={t(
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
                <p className="text-xs text-muted-foreground">
                  {t(
                    'components.settings.bitbucket.credentials.dialog.accessTokenNeeds',
                    'Needs read access to pull requests.'
                  )}
                </p>
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={emailId} variant="dialog-field">
                    {t(
                      'components.settings.bitbucket.credentials.dialog.atlassianEmail',
                      'Atlassian email'
                    )}
                  </Label>
                  <Input
                    id={emailId}
                    autoFocus
                    type="email"
                    placeholder={t(
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
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={apiTokenId} variant="dialog-field">
                      {t(
                        'auto.components.settings.bitbucket.credentials.dialog.apiToken',
                        'API token'
                      )}
                    </Label>
                    {docsLink}
                  </div>
                  <Input
                    id={apiTokenId}
                    type="password"
                    placeholder={t(
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
                  <DialogDisclosure
                    label={t(
                      'components.settings.bitbucket.credentials.dialog.requiredScopes',
                      'Required scopes'
                    )}
                  >
                    <BitbucketApiTokenScopes />
                  </DialogDisclosure>
                </div>
              </>
            )}
            <DialogDisclosure
              // Why open: a saved custom URL must stay visible, or editing it is a hidden step.
              defaultOpen={Boolean(initialBaseUrl?.trim())}
              variant="plain"
              label={t(
                'components.settings.bitbucket.credentials.dialog.apiBaseUrl',
                'API base URL'
              )}
            >
              <Input
                id={baseUrlId}
                aria-label={t(
                  'components.settings.bitbucket.credentials.dialog.apiBaseUrl',
                  'API base URL'
                )}
                placeholder={t(
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
            </DialogDisclosure>
          </div>
        )}
        {connectState === 'error' && connectError ? (
          <DialogError id={errorId}>{connectError}</DialogError>
        ) : null}
        <DialogFooter>
          <DialogCancel>
            {locked
              ? t('components.settings.bitbucket.credentials.dialog.close', 'Close')
              : t('auto.components.settings.bitbucket.credentials.dialog.cancel', 'Cancel')}
          </DialogCancel>
          {locked ? null : (
            <Button size="sm" onClick={() => void handleConnect()} disabled={!canSubmit}>
              {connecting
                ? t(
                    'components.settings.bitbucket.credentials.dialog.verifyingEllipsis',
                    'Verifying…'
                  )
                : t('auto.components.settings.bitbucket.credentials.dialog.connect', 'Connect')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
