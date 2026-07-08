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
import { JiraServerAuthFields, type JiraServerAuthMode } from '@/components/jira-server-auth-fields'
import type { JiraConnectArgs, JiraDeploymentType } from '../../../shared/types'

type JiraConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'
type DeploymentType = JiraDeploymentType

// Why: one dialog serves Settings, onboarding, and Tasks so Cloud and
// Server/DC validation cannot drift across entry points.
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
  const usernameId = useId()
  const passwordOrTokenId = useId()
  const bearerTokenId = useId()
  const errorId = useId()

  const [deploymentType, setDeploymentType] = useState<DeploymentType>('cloud')
  const [serverAuthMode, setServerAuthMode] = useState<JiraServerAuthMode>('basic')
  const [siteUrl, setSiteUrl] = useState('')
  const [email, setEmail] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [username, setUsername] = useState('')
  const [passwordOrToken, setPasswordOrToken] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  const canSubmit =
    connectState !== 'connecting' &&
    Boolean(siteUrl.trim()) &&
    (deploymentType === 'cloud'
      ? Boolean(email.trim()) && Boolean(apiToken.trim())
      : serverAuthMode === 'basic'
        ? Boolean(username.trim()) && Boolean(passwordOrToken.trim())
        : Boolean(bearerToken.trim()))
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.jira.connect.dialog.a98cdac833',
        'Your credential is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.jira.connect.dialog.3d156acced',
        'Your credential is stored locally and encrypted when local runtime storage supports it.'
      )
  const siteUrlPlaceholder =
    deploymentType === 'cloud'
      ? translate('auto.components.jira.connect.dialog.70fcd360c4', 'https://example.atlassian.net')
      : translate('auto.components.jira.connect.dialog.cbc27fa599', 'https://jira.example.com')

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const clearAllCredentialFields = (): void => {
    setEmail('')
    setApiToken('')
    setUsername('')
    setPasswordOrToken('')
    setBearerToken('')
  }

  const resetFormState = (): void => {
    setDeploymentType('cloud')
    setServerAuthMode('basic')
    setSiteUrl('')
    clearAllCredentialFields()
    setConnectState('idle')
    setConnectError(null)
  }

  const handleDeploymentTypeChange = (value: string): void => {
    if ((value === 'cloud' || value === 'server') && value !== deploymentType) {
      // Why: hidden credential fields should not keep stale secrets after mode switches.
      clearAllCredentialFields()
      setDeploymentType(value)
      clearErrorOnEdit()
    }
  }

  const handleServerAuthModeChange = (value: JiraServerAuthMode): void => {
    if (value === serverAuthMode) {
      return
    }
    // Why: hidden credential fields should not keep stale secrets after auth-mode switches.
    if (value === 'basic') {
      setBearerToken('')
    } else {
      setUsername('')
      setPasswordOrToken('')
    }
    setServerAuthMode(value)
    clearErrorOnEdit()
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      if (!nextOpen) {
        resetFormState()
      }
      onOpenChange(nextOpen)
    }
  }

  const buildConnectArgs = (): JiraConnectArgs => {
    const trimmedSite = siteUrl.trim()
    if (deploymentType === 'cloud') {
      return {
        deploymentType: 'cloud',
        siteUrl: trimmedSite,
        email: email.trim(),
        apiToken: apiToken.trim()
      }
    }
    if (serverAuthMode === 'basic') {
      return {
        deploymentType: 'server',
        authMode: 'basic',
        siteUrl: trimmedSite,
        username: username.trim(),
        passwordOrToken: passwordOrToken.trim()
      }
    }
    return {
      deploymentType: 'server',
      authMode: 'bearer',
      siteUrl: trimmedSite,
      bearerToken: bearerToken.trim()
    }
  }

  const handleConnect = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectJira(buildConnectArgs())
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        resetFormState()
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
            {translate(
              'auto.components.jira.connect.dialog.d9c1d14dfc',
              'Connect a Jira Cloud or Server/Data Center site to browse and update issues.'
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
            <div className="space-y-2">
              <Label className="text-xs">
                {translate('auto.components.jira.connect.dialog.aa36f6b51e', 'Jira type')}
              </Label>
              <ToggleGroup
                type="single"
                value={deploymentType}
                onValueChange={handleDeploymentTypeChange}
                disabled={connectState === 'connecting'}
                variant="outline"
                size="sm"
                className="w-full"
              >
                <ToggleGroupItem value="cloud" className="flex-1">
                  {translate('auto.components.jira.connect.dialog.78ce04423a', 'Cloud')}
                </ToggleGroupItem>
                <ToggleGroupItem value="server" className="flex-1">
                  {translate(
                    'auto.components.jira.connect.dialog.f7c6874229',
                    'Server/Data Center'
                  )}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="space-y-2">
              <Label htmlFor={siteUrlId} className="text-xs">
                {deploymentType === 'cloud'
                  ? translate(
                      'auto.components.jira.connect.dialog.e176f9d0c5',
                      'Jira Cloud site URL'
                    )
                  : translate('auto.components.jira.connect.dialog.3489e186d6', 'Jira site URL')}
              </Label>
              <Input
                id={siteUrlId}
                autoFocus
                placeholder={siteUrlPlaceholder}
                value={siteUrl}
                onChange={(event) => {
                  setSiteUrl(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            {deploymentType === 'cloud' ? (
              <>
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
                <div className="space-y-2">
                  <Label htmlFor={tokenId} className="text-xs">
                    {translate('auto.components.jira.connect.dialog.3d81bf3ab3', 'API token')}
                  </Label>
                  <Input
                    id={tokenId}
                    type="password"
                    placeholder={translate(
                      'auto.components.jira.connect.dialog.7b3967c12f',
                      'Atlassian API token'
                    )}
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
              </>
            ) : (
              <JiraServerAuthFields
                authMode={serverAuthMode}
                onAuthModeChange={handleServerAuthModeChange}
                username={username}
                onUsernameChange={(value) => {
                  setUsername(value)
                  clearErrorOnEdit()
                }}
                passwordOrToken={passwordOrToken}
                onPasswordOrTokenChange={(value) => {
                  setPasswordOrToken(value)
                  clearErrorOnEdit()
                }}
                bearerToken={bearerToken}
                onBearerTokenChange={(value) => {
                  setBearerToken(value)
                  clearErrorOnEdit()
                }}
                usernameId={usernameId}
                passwordOrTokenId={passwordOrTokenId}
                bearerTokenId={bearerTokenId}
                disabled={connectState === 'connecting'}
                hasError={connectState === 'error'}
                errorId={errorId}
              />
            )}
            {connectState === 'error' && connectError ? (
              <p id={errorId} className="text-xs text-destructive">
                {connectError}
              </p>
            ) : null}
            {deploymentType === 'cloud' ? (
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
            ) : null}
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {credentialStorageCopy}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
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
