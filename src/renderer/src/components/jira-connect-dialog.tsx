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
import { cn } from '@/lib/utils'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_JIRA_CONNECT_MODE,
  describeJiraConnectMode,
  jiraConnectCopy,
  type JiraConnectMode
} from './jira-connect-mode'
import { JiraConnectModeToggles } from './jira-connect-mode-toggles'

type JiraConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

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

  const [mode, setMode] = useState<JiraConnectMode>(DEFAULT_JIRA_CONNECT_MODE)
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
    setMode(DEFAULT_JIRA_CONNECT_MODE)
    setSiteUrl('')
    setEmail('')
    setApiToken('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const shape = describeJiraConnectMode(mode)
  const { isServer, isScopedCloud, needsIdentity } = shape
  const copy = jiraConnectCopy(shape)
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
  const handleModeChange = (nextMode: JiraConnectMode): void => {
    setMode(nextMode)
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
        authType: shape.authType
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setSiteUrl('')
        setEmail('')
        setApiToken('')
        setMode(DEFAULT_JIRA_CONNECT_MODE)
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
          <DialogDescription>{copy.description}</DialogDescription>
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
            <JiraConnectModeToggles
              mode={mode}
              disabled={connectState === 'connecting'}
              onChange={handleModeChange}
            />
            <div className="space-y-2">
              <Label htmlFor={siteUrlId} className="text-xs">
                {copy.siteUrlLabel}
              </Label>
              <Input
                id={siteUrlId}
                autoFocus
                placeholder={copy.siteUrlPlaceholder}
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
                  {copy.identityLabel}
                </Label>
                <Input
                  id={emailId}
                  type={copy.identityInputType}
                  placeholder={copy.identityPlaceholder}
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
                {copy.tokenLabel}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder={copy.tokenPlaceholder}
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
            {shape.isServerBasic ? (
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
                {isScopedCloud
                  ? translate(
                      'auto.components.jira.connect.dialog.cc1ca58cd8',
                      'Create a token with scopes in'
                    )
                  : translate(
                      'auto.components.jira.connect.dialog.8090504a3e',
                      'Create a token in'
                    )}{' '}
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
                {isScopedCloud
                  ? ` ${translate(
                      'auto.components.jira.connect.dialog.fbf2400a02',
                      'and grant read:jira-work, write:jira-work, and read:jira-user.'
                    )}`
                  : '.'}
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
