import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useMountedRef } from '@/hooks/useMountedRef'
import { taskProviderErrorMessage } from '@/lib/work-items/task-provider-error-copy'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { UnsealedCredentialNotice } from '../../provider-accounts/UnsealedCredentialNotice'
import { providerAccountScopeForTarget } from '../../provider-accounts/provider-account-scope'
import { ProviderHostScopeControl } from '../../provider-accounts/ProviderHostScopeControl'
import {
  IntegrationCardDetails,
  IntegrationCardShell
} from '../presentation/integration-card-shell'
import { useIntegrationSubordinateRowClass } from '../presentation/integration-card-presentation'
import { ClickUpTokenDialog } from './clickup-token-dialog'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { clickupOwnerContextKey } from '@/store/slices/clickup/clickup-read-coordination'
import { CLICKUP_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'

type VerificationResult = { state: 'ok' } | { state: 'error'; error: string }

export function ClickUpIntegrationCard({
  owner
}: {
  /** The host whose ClickUp credentials this card manages. */
  owner: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
  const clickupStatus = useAppStore((s) => s.clickupStatus)
  const clickupStatusChecked = useAppStore((s) => s.clickupStatusChecked)
  // Matched inside the selector so the live runtime key is never read during render.
  const contextMatches = useAppStore(
    (s) => s.clickupStatusContextKey === clickupOwnerContextKey(owner)
  )
  const runtimeUpdateRequired = useAppStore((s) => s.clickupRuntimeUpdateRequired) && contextMatches
  const clickupConnectionLost = useAppStore((s) => s.clickupConnectionLost)
  const checkClickUpConnection = useAppStore((s) => s.checkClickUpConnection)
  const disconnectClickUp = useAppStore((s) => s.disconnectClickUp)
  const testClickUpConnection = useAppStore((s) => s.testClickUpConnection)
  const selectClickUpWorkspace = useAppStore((s) => s.selectClickUpWorkspace)
  const mountedRef = useMountedRef()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<VerificationResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const checking = !contextMatches || !clickupStatusChecked
  const connected = contextMatches && clickupStatus.connected
  const accountScope = providerAccountScopeForTarget(owner, t)
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')
  const credentialCopy =
    owner.kind === 'environment'
      ? t(
          'taskProviders.clickup.remoteCredentialCopy',
          'Connect ClickUp with a personal API token. The token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
        )
      : t(
          'taskProviders.clickup.localCredentialCopy',
          'Connect ClickUp with a personal API token. The token is stored locally and encrypted when local runtime storage supports it.'
        )

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    const result = await testClickUpConnection(owner)
    if (!mountedRef.current) {
      return
    }
    setTestResult(
      result.ok ? { state: 'ok' } : { state: 'error', error: taskProviderErrorMessage(result) }
    )
    setTesting(false)
  }

  const handleDisconnect = async (): Promise<void> => {
    setActionError(null)
    try {
      await disconnectClickUp(owner)
      if (mountedRef.current) {
        setTestResult(null)
      }
    } catch (error) {
      if (mountedRef.current) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const handleSelectWorkspace = async (workspaceId: string): Promise<void> => {
    setActionError(null)
    try {
      await selectClickUpWorkspace(owner, workspaceId)
    } catch (error) {
      if (mountedRef.current) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  return (
    <IntegrationCardShell
      settingsSectionId={CLICKUP_INTEGRATION_SECTION_ID}
      icon={<ClickUpIcon className="size-5" />}
      name="ClickUp"
      description={
        connected
          ? t('taskProviders.clickup.connectedAs', 'Connected as {{name}}', {
              name: clickupStatus.viewer?.username ?? clickupStatus.viewer?.email ?? ''
            })
          : checking
            ? t(
                'taskProviders.clickup.checking',
                'Checking ClickUp access before showing setup actions.'
              )
            : runtimeUpdateRequired
              ? t(
                  'taskProviders.clickup.runtimeUpdateBody',
                  'Update the remote runtime to connect ClickUp.'
                )
              : clickupConnectionLost
                ? t(
                    'taskProviders.clickup.connectionLost',
                    'ClickUp rejected the saved token. Connect again with a new personal API token.'
                  )
                : t(
                    'taskProviders.clickup.description',
                    'Browse ClickUp tasks, update their status, and start work from them.'
                  )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? t('taskProviders.clickup.statusConnected', 'Connected')
          : t('taskProviders.clickup.statusNotConnected', 'Not connected')
      }
      actions={
        !checking && !runtimeUpdateRequired ? (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? t('taskProviders.clickup.updateToken', 'Update token')
              : t('taskProviders.clickup.connectAction', 'Connect ClickUp')}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <UnsealedCredentialNotice
          protection={clickupStatus.credentialProtection ?? null}
          credentialName={t('taskProviders.clickup.tokenName', 'Your ClickUp API token')}
        />
        <ProviderHostScopeControl
          labelPrefix={t(
            'auto.components.settings.task.tracker.integration.cards.account_scope_prefix',
            'Account scope'
          )}
          scope={accountScope}
          className={accountScopeRowClass}
        />
        {connected ? (
          <div className="space-y-2">
            {clickupStatus.credentialError ? (
              <p role="alert" className="text-xs text-destructive">
                {clickupStatus.credentialError}
              </p>
            ) : null}
            <div className={subordinateRowClass}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {clickupStatus.viewer?.username}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {clickupStatus.viewer?.email}
                </p>
              </div>
              {testResult?.state === 'ok' ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                  <CheckCircle2 className="size-3.5" />
                  {t('taskProviders.clickup.verified', 'Verified')}
                </span>
              ) : null}
              {testResult?.state === 'error' ? (
                <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-destructive">
                  <AlertCircle className="size-3.5 shrink-0" />
                  <span className="truncate">{testResult.error}</span>
                </span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTest()}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                    {t('taskProviders.clickup.testing', 'Testing...')}
                  </>
                ) : (
                  t('taskProviders.clickup.test', 'Test')
                )}
              </Button>
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                aria-label={t('taskProviders.clickup.disconnect', 'Disconnect ClickUp')}
                className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
              >
                <Unlink className="size-3.5" />
              </button>
            </div>
            {clickupStatus.workspaces.length > 1 ? (
              <div className={subordinateRowClass}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {t('taskProviders.clickup.workspaceLabel', 'Workspace')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'taskProviders.clickup.workspaceHint',
                      'This token reaches several Workspaces. Tasks shows the one selected here.'
                    )}
                  </p>
                </div>
                <Select
                  value={clickupStatus.selectedWorkspaceId ?? undefined}
                  onValueChange={(workspaceId) => void handleSelectWorkspace(workspaceId)}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-[220px]"
                    aria-label={t('taskProviders.clickup.workspaceLabel', 'Workspace')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {clickupStatus.workspaces.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {actionError ? (
              <p role="alert" className="text-xs text-destructive">
                {actionError}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground/70">
              {t(
                'taskProviders.clickup.singleTokenNote',
                'One token is stored by the active runtime and covers every ClickUp Workspace you belong to.'
              )}
            </p>
          </div>
        ) : !checking && !runtimeUpdateRequired ? (
          <>
            <p className="text-xs text-muted-foreground">{credentialCopy}</p>
            <Button variant="ghost" size="sm" onClick={() => void checkClickUpConnection(owner)}>
              {t('auto.components.settings.task.tracker.integration.cards.c90f2ef419', 'Re-check')}
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>

      <ClickUpTokenDialog
        owner={owner}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        reconnect={connected || clickupConnectionLost}
        onConnected={() => setTestResult(null)}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
