import { useId, useState } from 'react'
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
import type { JiraDeployment } from '../../../shared/types'

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

  const [deployment, setDeployment] = useState<JiraDeployment>('cloud')
  const [siteUrl, setSiteUrl] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  const isDatacenter = deployment === 'datacenter'
  // Cloud needs the Atlassian email; Data Center authenticates with a personal
  // access token (Bearer) and needs only the token, with username optional for
  // username/password auth on older servers.
  const canSubmit =
    Boolean(siteUrl.trim()) &&
    Boolean(apiToken.trim()) &&
    (isDatacenter || Boolean(email.trim())) &&
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

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  const handleConnect = async (): Promise<void> => {
    const trimmedSite = siteUrl.trim()
    const trimmedEmail = email.trim()
    const trimmedUsername = username.trim()
    const trimmedToken = apiToken.trim()
    if (
      !trimmedSite ||
      !trimmedToken ||
      (!isDatacenter && !trimmedEmail) ||
      connectState === 'connecting'
    ) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectJira({
        siteUrl: trimmedSite,
        email: trimmedEmail,
        apiToken: trimmedToken,
        deployment,
        ...(isDatacenter && trimmedUsername ? { username: trimmedUsername } : {})
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setSiteUrl('')
        setEmail('')
        setUsername('')
        setApiToken('')
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
            {isDatacenter
              ? translate(
                  'auto.components.jira.connect.dialog.dc.description',
                  'Use your Jira Data Center / Server URL and a personal access token to browse issues.'
                )
              : translate(
                  'auto.components.jira.connect.dialog.d785c42b8b',
                  'Use a Jira Cloud site URL, Atlassian email, and API token to browse issues.'
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleConnect()
          }}
        >
          <div className="flex flex-col gap-3">
            <ToggleGroup
              type="single"
              variant="outline"
              value={deployment}
              onValueChange={(value) => {
                if (value === 'cloud' || value === 'datacenter') {
                  setDeployment(value)
                  clearErrorOnEdit()
                }
              }}
              className="w-full"
            >
              <ToggleGroupItem
                value="cloud"
                className="flex-1"
                disabled={connectState === 'connecting'}
              >
                {translate('auto.components.jira.connect.dialog.deployment.cloud', 'Cloud')}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="datacenter"
                className="flex-1"
                disabled={connectState === 'connecting'}
              >
                {translate(
                  'auto.components.jira.connect.dialog.deployment.datacenter',
                  'Data Center'
                )}
              </ToggleGroupItem>
            </ToggleGroup>
            <div className="space-y-2">
              <Label htmlFor={siteUrlId} className="text-xs">
                {isDatacenter
                  ? translate(
                      'auto.components.jira.connect.dialog.dc.siteUrl',
                      'Jira Data Center URL'
                    )
                  : translate(
                      'auto.components.jira.connect.dialog.e176f9d0c5',
                      'Jira Cloud site URL'
                    )}
              </Label>
              <Input
                id={siteUrlId}
                autoFocus
                placeholder={
                  isDatacenter
                    ? translate(
                        'auto.components.jira.connect.dialog.dc.siteUrlPlaceholder',
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
            {isDatacenter ? (
              <div className="space-y-2">
                <Label htmlFor={emailId} className="text-xs">
                  {translate(
                    'auto.components.jira.connect.dialog.dc.username',
                    'Username (optional)'
                  )}
                </Label>
                <Input
                  id={emailId}
                  placeholder={translate(
                    'auto.components.jira.connect.dialog.dc.usernamePlaceholder',
                    'Only for username/password servers'
                  )}
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value)
                    clearErrorOnEdit()
                  }}
                  disabled={connectState === 'connecting'}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor={emailId} className="text-xs">
                  {translate('auto.components.jira.connect.dialog.2849ddb295', 'Atlassian email')}
                </Label>
                <Input
                  id={emailId}
                  type="email"
                  placeholder={translate(
                    'auto.components.jira.connect.dialog.e91b9a4073',
                    'you@example.com'
                  )}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    clearErrorOnEdit()
                  }}
                  disabled={connectState === 'connecting'}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={tokenId} className="text-xs">
                {isDatacenter
                  ? translate(
                      'auto.components.jira.connect.dialog.dc.token',
                      'Personal access token'
                    )
                  : translate('auto.components.jira.connect.dialog.3d81bf3ab3', 'API token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder={
                  isDatacenter
                    ? translate(
                        'auto.components.jira.connect.dialog.dc.tokenPlaceholder',
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
            {isDatacenter ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.jira.connect.dialog.dc.tokenHelp',
                  'Create a personal access token from your Jira profile under Personal Access Tokens.'
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
