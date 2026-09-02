import { useId, useLayoutEffect, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
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

type JiraConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'
type JiraInstanceType = 'cloud' | 'server'
// Self-hosted Jira accepts either a personal access token (Bearer) or classic
// username + password (Basic); older Server/DC instances predate PATs.
type ServerAuthMethod = 'pat' | 'basic'

// Why: mirrors the inline Jira connect dialog in TaskPage so the onboarding
// "Connect integrations" step can reuse the same site URL + email + API token
// flow without depending on TaskPage's local state.
export function JiraConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: JiraConnectDialogProps): React.JSX.Element {
  const connectJira = useAppStore((s) => s.connectJira)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const siteUrlId = useId()
  const emailId = useId()
  const tokenId = useId()
  const errorId = useId()

  const [instanceType, setInstanceType] = useState<JiraInstanceType>('cloud')
  const [serverAuthMethod, setServerAuthMethod] = useState<ServerAuthMethod>('pat')
  const [siteUrl, setSiteUrl] = useState('')
  const [email, setEmail] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Start every open with a clean slate so a previously-typed secret, stale
  // instance/auth-method selection, or old error can't linger across reopens.
  // Runs before paint so a stale credential never renders for a frame.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setInstanceType('cloud')
    setServerAuthMethod('pat')
    setSiteUrl('')
    setEmail('')
    setApiToken('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const isServer = instanceType === 'server'
  // `needsIdentity` folds "Cloud Atlassian email" and "self-hosted Basic
  // username" — the identity slot that keys/labels the stored site. PAT auth
  // uses no identity, so the email field is hidden and left empty.
  const isServerBasic = isServer && serverAuthMethod === 'basic'
  const needsIdentity = !isServer || isServerBasic
  const canSubmit =
    Boolean(siteUrl.trim()) &&
    (!needsIdentity || Boolean(email.trim())) &&
    Boolean(apiToken.trim()) &&
    connectState !== 'connecting'
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? 'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
    : 'Your token is stored locally and encrypted when local runtime storage supports it.'

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  // A Cloud email, a Server username, a PAT, and an account password are
  // different secrets; drop the credential fields when the deployment or auth
  // method changes so one can't be submitted as another (e.g. a password
  // silently riding along as a Bearer PAT).
  const clearCredentialsOnModeSwitch = (): void => {
    setEmail('')
    setApiToken('')
    clearErrorOnEdit()
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  const handleConnect = async (): Promise<void> => {
    const trimmedSite = siteUrl.trim()
    const trimmedEmail = email.trim()
    const trimmedToken = apiToken.trim()
    if (
      !trimmedSite ||
      (needsIdentity && !trimmedEmail) ||
      !trimmedToken ||
      connectState === 'connecting'
    ) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectJira({
        siteUrl: trimmedSite,
        // Cloud sends the Atlassian email; self-hosted Basic sends the username;
        // PAT sends nothing, so a stale email can't key/label the stored site.
        email: needsIdentity ? trimmedEmail : '',
        apiToken: trimmedToken,
        authType: instanceType
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setSiteUrl('')
        setEmail('')
        setApiToken('')
        setInstanceType('cloud')
        setServerAuthMethod('pat')
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
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-md', contentClassName)}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {translate('auto.components.jira.connect.dialog.8388bdea2b', 'Connect Jira site')}
          </DialogTitle>
          <DialogDescription>
            {!isServer
              ? translate(
                  'auto.components.jira.connect.dialog.d785c42b8b',
                  'Use a Jira Cloud site URL, Atlassian email, and API token to browse issues.'
                )
              : isServerBasic
                ? translate(
                    'auto.components.jira.connect.dialog.1d947a07ab',
                    'Use a self-hosted Jira base URL, username, and password to browse issues.'
                  )
                : translate(
                    'auto.components.jira.connect.dialog.2e2b69e48e',
                    'Use a self-hosted Jira base URL and a personal access token to browse issues.'
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
            <ToggleGroup
              type="single"
              variant="outline"
              value={instanceType}
              disabled={connectState === 'connecting'}
              onValueChange={(value) => {
                if (!value || connectState === 'connecting') {
                  return
                }
                setInstanceType(value as JiraInstanceType)
                clearCredentialsOnModeSwitch()
              }}
              aria-label={translate(
                'auto.components.jira.connect.dialog.b67e919bd5',
                'Jira instance type'
              )}
            >
              <ToggleGroupItem value="cloud" className="h-8 px-3 text-xs">
                {translate('auto.components.jira.connect.dialog.17787d6e4b', 'Atlassian Cloud')}
              </ToggleGroupItem>
              <ToggleGroupItem value="server" className="h-8 px-3 text-xs">
                {translate('auto.components.jira.connect.dialog.bc7a831773', 'Self-hosted')}
              </ToggleGroupItem>
            </ToggleGroup>
            {isServer ? (
              <ToggleGroup
                type="single"
                variant="outline"
                value={serverAuthMethod}
                disabled={connectState === 'connecting'}
                onValueChange={(value) => {
                  if (!value || connectState === 'connecting') {
                    return
                  }
                  setServerAuthMethod(value as ServerAuthMethod)
                  clearCredentialsOnModeSwitch()
                }}
                aria-label={translate(
                  'auto.components.jira.connect.dialog.f49708c369',
                  'Jira authentication method'
                )}
              >
                <ToggleGroupItem value="pat" className="h-8 px-3 text-xs">
                  {translate(
                    'auto.components.jira.connect.dialog.730d973bae',
                    'Personal access token'
                  )}
                </ToggleGroupItem>
                <ToggleGroupItem value="basic" className="h-8 px-3 text-xs">
                  {translate(
                    'auto.components.jira.connect.dialog.84a810dd0e',
                    'Username & password'
                  )}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={siteUrlId} className="text-xs">
                {isServer
                  ? translate('auto.components.jira.connect.dialog.3489e186d6', 'Jira site URL')
                  : translate(
                      'auto.components.jira.connect.dialog.e176f9d0c5',
                      'Jira Cloud site URL'
                    )}
              </Label>
              <Input
                id={siteUrlId}
                autoFocus
                placeholder={
                  isServer
                    ? translate(
                        'auto.components.jira.connect.dialog.cbc27fa599',
                        'https://jira.example.com'
                      )
                    : translate(
                        'auto.components.jira.connect.dialog.70fcd360c4',
                        'https://example.atlassian.net'
                      )
                }
                value={siteUrl}
                onChange={(event) => {
                  setSiteUrl(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            {needsIdentity ? (
              <div className="space-y-2">
                <Label htmlFor={emailId} className="text-xs">
                  {isServerBasic
                    ? translate('auto.components.jira.connect.dialog.8d1223fa5c', 'Username')
                    : translate(
                        'auto.components.jira.connect.dialog.2849ddb295',
                        'Atlassian email'
                      )}
                </Label>
                <Input
                  id={emailId}
                  type={isServerBasic ? 'text' : 'email'}
                  placeholder={
                    isServerBasic
                      ? translate('auto.components.jira.connect.dialog.be9eba0a1b', 'username')
                      : translate(
                          'auto.components.jira.connect.dialog.e91b9a4073',
                          'you@example.com'
                        )
                  }
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    clearErrorOnEdit()
                  }}
                  disabled={connectState === 'connecting'}
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={tokenId} className="text-xs">
                {isServerBasic
                  ? translate('auto.components.jira.connect.dialog.70035652d7', 'Password')
                  : isServer
                    ? translate(
                        'auto.components.jira.connect.dialog.730d973bae',
                        'Personal access token'
                      )
                    : translate('auto.components.jira.connect.dialog.3d81bf3ab3', 'API token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder={
                  isServerBasic
                    ? translate(
                        'auto.components.jira.connect.dialog.c50abbf340',
                        'Jira account password'
                      )
                    : isServer
                      ? translate(
                          'auto.components.jira.connect.dialog.8b9c7b9e7b',
                          'Jira personal access token'
                        )
                      : translate(
                          'auto.components.jira.connect.dialog.7b3967c12f',
                          'Atlassian API token'
                        )
                }
                value={apiToken}
                onChange={(event) => {
                  setApiToken(event.target.value)
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
            {isServerBasic ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.jira.connect.dialog.d8737db691',
                  'Use your Jira Server or Data Center account username and password.'
                )}
              </p>
            ) : isServer ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.jira.connect.dialog.ccfb086d3e',
                  'Create a personal access token in your Jira profile under Personal Access Tokens.'
                )}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {translate('auto.components.jira.connect.dialog.8090504a3e', 'Create a token in')}{' '}
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() =>
                    window.api.shell.openUrl(
                      'https://id.atlassian.com/manage-profile/security/api-tokens'
                    )
                  }
                >
                  {translate(
                    'auto.components.jira.connect.dialog.fdd26d81cc',
                    'Atlassian account settings'
                  )}
                </button>
                .
              </p>
            )}
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
              {translate('auto.components.jira.connect.dialog.79e7aaed39', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.jira.connect.dialog.4a2ab52781', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.jira.connect.dialog.63ce735809', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
