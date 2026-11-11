import { jiraCredentialStorageCopy } from './jira-credential-storage-copy'
import {
  taskProviderErrorMessage,
  taskProviderErrorText
} from '@/lib/work-items/task-provider-error-copy'
import { useId, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import { useAppStore } from '@/store/index'
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
import { cn } from '@/lib/class-names'
import {
  getProviderRuntimeContextKey,
  isEnvironmentRuntimeContextKey
} from '@/runtime/hosts/observations/provider-runtime-context'
import { preventOutsideDismissWhenDirty } from '@/lib/outside-dismiss-guard'
import { useTranslate } from '@/i18n/use-translate'
import { JiraConnectCredentialGuide } from './jira-connect-credential-guide'

type JiraConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'
type JiraInstanceType = 'cloud' | 'server'
// Support Basic auth for older Server/DC instances that predate personal access tokens.
type ServerAuthMethod = 'pat' | 'basic'

export function JiraConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: JiraConnectDialogProps): React.JSX.Element {
  const t = useTranslate()
  const connectJira = useAppStore((s) => s.connectJira)
  const settings = useAppStore((s) => s.settings)
  const hostSupportsScopedTokens = useAppStore((s) => s.jiraStatus?.supportsScopedTokens === true)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const remoteRuntime = isEnvironmentRuntimeContextKey(providerRuntimeContextKey)
  const supportsScopedTokens =
    !remoteRuntime ||
    (jiraStatusContextKey === providerRuntimeContextKey && hostSupportsScopedTokens)
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

  // Clear secrets, modes and errors before paint on each open so prior credentials cannot flash or persist.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setInstanceType('cloud')
      setServerAuthMethod('pat')
      setSiteUrl('')
      setEmail('')
      setApiToken('')
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const isServer = instanceType === 'server'
  // Cloud email and Server Basic username share the identity slot; PAT auth has no identity.
  const isServerBasic = isServer && serverAuthMethod === 'basic'
  const needsIdentity = !isServer || isServerBasic
  const requiresIdentity = isServerBasic || (!isServer && !supportsScopedTokens)
  const canSubmit =
    Boolean(siteUrl.trim()) &&
    (!requiresIdentity || Boolean(email.trim())) &&
    Boolean(apiToken.trim()) &&
    connectState !== 'connecting'
  const credentialStorageCopy = jiraCredentialStorageCopy(remoteRuntime, t)

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  // Clear credentials on auth/deployment changes so passwords cannot be submitted as PATs or other secret types.
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

  // Keep typed credentials on backdrop clicks; mode switches clear them, while explicit dismissal remains available.
  const isDraftDirty = (): boolean => siteUrl !== '' || email !== '' || apiToken !== ''
  const guardOutsideDismiss = preventOutsideDismissWhenDirty(isDraftDirty)

  const handleConnect = async (): Promise<void> => {
    const trimmedSite = siteUrl.trim()
    const trimmedEmail = email.trim()
    const trimmedToken = apiToken.trim()
    if (
      !trimmedSite ||
      (requiresIdentity && !trimmedEmail) ||
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
        // PAT auth must not inherit a stale identity used to key or label the stored site.
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
      setConnectError(taskProviderErrorMessage(result))
    } catch (error) {
      if (mountedRef.current) {
        setConnectState('error')
        setConnectError(
          error instanceof Error
            ? taskProviderErrorText(error.message)
            : t('taskProviders.jira.connectionFailed', 'Connection failed')
        )
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-md', contentClassName)}
        onPointerDownOutside={guardOutsideDismiss}
        onInteractOutside={guardOutsideDismiss}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {t('auto.components.jira.connect.dialog.8388bdea2b', 'Connect Jira site')}
          </DialogTitle>
          <DialogDescription>
            {!isServer
              ? supportsScopedTokens
                ? t(
                    'jira.connect.scopedDescription',
                    'Use a Jira Cloud site URL and API token to browse issues. Scoped tokens can omit the email.'
                  )
                : t(
                    'auto.components.jira.connect.dialog.d785c42b8b',
                    'Use a Jira Cloud site URL, Atlassian email, and API token to browse issues.'
                  )
              : isServerBasic
                ? t(
                    'auto.components.jira.connect.dialog.1d947a07ab',
                    'Use a self-hosted Jira base URL, username, and password to browse issues.'
                  )
                : t(
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
              aria-label={t('auto.components.jira.connect.dialog.b67e919bd5', 'Jira instance type')}
            >
              <ToggleGroupItem value="cloud" className="h-8 px-3 text-xs">
                {t('auto.components.jira.connect.dialog.17787d6e4b', 'Atlassian Cloud')}
              </ToggleGroupItem>
              <ToggleGroupItem value="server" className="h-8 px-3 text-xs">
                {t('auto.components.jira.connect.dialog.bc7a831773', 'Self-hosted')}
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
                aria-label={t(
                  'auto.components.jira.connect.dialog.f49708c369',
                  'Jira authentication method'
                )}
              >
                <ToggleGroupItem value="pat" className="h-8 px-3 text-xs">
                  {t('auto.components.jira.connect.dialog.730d973bae', 'Personal access token')}
                </ToggleGroupItem>
                <ToggleGroupItem value="basic" className="h-8 px-3 text-xs">
                  {t('auto.components.jira.connect.dialog.84a810dd0e', 'Username & password')}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={siteUrlId} className="text-xs">
                {isServer
                  ? t('auto.components.jira.connect.dialog.3489e186d6', 'Jira site URL')
                  : t('auto.components.jira.connect.dialog.e176f9d0c5', 'Jira Cloud site URL')}
              </Label>
              <Input
                id={siteUrlId}
                autoFocus
                placeholder={
                  isServer
                    ? t(
                        'auto.components.jira.connect.dialog.cbc27fa599',
                        'https://jira.example.com'
                      )
                    : t(
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
                    ? t('auto.components.jira.connect.dialog.8d1223fa5c', 'Username')
                    : supportsScopedTokens
                      ? t(
                          'jira.connect.optionalEmail',
                          'Atlassian email (optional for scoped tokens)'
                        )
                      : t('auto.components.jira.connect.dialog.2849ddb295', 'Atlassian email')}
                </Label>
                <Input
                  id={emailId}
                  type={isServerBasic ? 'text' : 'email'}
                  placeholder={
                    isServerBasic
                      ? t('auto.components.jira.connect.dialog.be9eba0a1b', 'username')
                      : t('auto.components.jira.connect.dialog.e91b9a4073', 'you@example.com')
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
                  ? t('auto.components.jira.connect.dialog.70035652d7', 'Password')
                  : isServer
                    ? t('auto.components.jira.connect.dialog.730d973bae', 'Personal access token')
                    : t('auto.components.jira.connect.dialog.3d81bf3ab3', 'API token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder={
                  isServerBasic
                    ? t('auto.components.jira.connect.dialog.c50abbf340', 'Jira account password')
                    : isServer
                      ? t(
                          'auto.components.jira.connect.dialog.8b9c7b9e7b',
                          'Jira personal access token'
                        )
                      : t('auto.components.jira.connect.dialog.7b3967c12f', 'Atlassian API token')
                }
                value={apiToken}
                onChange={(event) => {
                  setApiToken(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
                aria-describedby={connectState === 'error' ? errorId : undefined}
              />
            </div>
            {connectState === 'error' && connectError ? (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {connectError}
              </p>
            ) : null}
            <JiraConnectCredentialGuide
              isServer={isServer}
              isServerBasic={isServerBasic}
              supportsScopedTokens={supportsScopedTokens}
            />
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
              {t('auto.components.jira.connect.dialog.79e7aaed39', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {t('auto.components.jira.connect.dialog.4a2ab52781', 'Verifying…')}
                </>
              ) : (
                t('auto.components.jira.connect.dialog.63ce735809', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
