import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { ShortcutConnectDialog } from '@/components/shortcut-connect-dialog'
import { ShortcutIcon } from '@/components/icons/ShortcutIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getProviderRuntimeContextKey,
  hasRemoteProviderRuntime
} from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { getProviderAccountScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { SHORTCUT_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function ShortcutIntegrationCard(): React.JSX.Element {
  const shortcutStatus = useAppStore((s) => s.shortcutStatus)
  const shortcutStatusChecked = useAppStore((s) => s.shortcutStatusChecked)
  const shortcutStatusContextKey = useAppStore((s) => s.shortcutStatusContextKey)
  const checkShortcutConnection = useAppStore((s) => s.checkShortcutConnection)
  const disconnectShortcut = useAppStore((s) => s.disconnectShortcut)
  const testShortcutConnection = useAppStore((s) => s.testShortcutConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingWorkspaceIds, setTestingWorkspaceIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [testResultByWorkspace, setTestResultByWorkspace] = useState<
    Record<string, VerificationResult>
  >({})

  const contextMatches = shortcutStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !shortcutStatusChecked
  const connected = contextMatches && shortcutStatus.connected
  const workspaces = shortcutStatus.workspaces ?? []
  const workspaceCount = workspaces.length || (connected ? 1 : 0)
  const accountScope = getProviderAccountScope(settings)
  const credentialCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.settings.shortcut.integration.card.credentialCopyRemote',
        'Connect a Shortcut workspace with an API token. Credentials are sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.settings.shortcut.integration.card.credentialCopyLocal',
        'Connect a Shortcut workspace with an API token. Credentials are stored locally and encrypted when local runtime storage supports it.'
      )
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')

  const handleDisconnect = async (workspaceId?: string): Promise<void> => {
    await disconnectShortcut(workspaceId)
    if (mountedRef.current) {
      setTestResultByWorkspace({})
    }
  }

  // Why: explicit user-triggered verification. This is the only settings path
  // that decrypts a stored Shortcut token, avoiding surprise keychain prompts.
  const handleTest = async (workspaceId: string): Promise<void> => {
    setTestingWorkspaceIds((prev) => new Set(prev).add(workspaceId))
    setTestResultByWorkspace((prev) => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
    const result = await testShortcutConnection(workspaceId)
    if (!mountedRef.current) {
      return
    }
    setTestResultByWorkspace((prev) => ({
      ...prev,
      [workspaceId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
    }))
    setTestingWorkspaceIds((prev) => {
      const next = new Set(prev)
      next.delete(workspaceId)
      return next
    })
  }

  return (
    <IntegrationCardShell
      settingsSectionId={SHORTCUT_INTEGRATION_SECTION_ID}
      icon={<ShortcutIcon className="size-5" />}
      name="Shortcut"
      description={
        connected
          ? translate(
              'auto.components.settings.shortcut.integration.card.connectedCount',
              '{{value0}} workspace{{value1}} connected',
              { value0: workspaceCount, value1: workspaceCount === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.shortcut.integration.card.checking',
                'Checking Shortcut access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.shortcut.integration.card.pitch',
                'Browse, create, and start work from Shortcut stories.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate(
              'auto.components.settings.shortcut.integration.card.statusConnected',
              'Connected'
            )
          : translate(
              'auto.components.settings.shortcut.integration.card.statusNotConnected',
              'Not connected'
            )
      }
      actions={
        !checking ? (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? translate(
                  'auto.components.settings.shortcut.integration.card.addWorkspace',
                  'Add Shortcut workspace'
                )
              : translate(
                  'auto.components.settings.shortcut.integration.card.connect',
                  'Connect Shortcut'
                )}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <ProviderHostScopeControl
          labelPrefix={translate(
            'auto.components.settings.shortcut.integration.card.accountScopePrefix',
            'Account scope'
          )}
          scope={accountScope}
          className={accountScopeRowClass}
        />
        {connected && workspaces.length > 0 ? (
          <div className="space-y-2">
            {workspaces.map((workspace) => {
              const testResult = testResultByWorkspace[workspace.id]
              const testing = testingWorkspaceIds.has(workspace.id)
              return (
                <div key={workspace.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{workspace.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {workspace.urlSlug}
                      {workspace.memberName ? ` · ${workspace.memberName}` : ''}
                    </p>
                  </div>
                  {testResult?.state === 'ok' ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                      <CheckCircle2 className="size-3.5" />
                      {translate(
                        'auto.components.settings.shortcut.integration.card.verified',
                        'Verified'
                      )}
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
                    onClick={() => void handleTest(workspace.id)}
                    disabled={testing}
                  >
                    {testing ? (
                      <>
                        <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                        {translate(
                          'auto.components.settings.shortcut.integration.card.testing',
                          'Testing...'
                        )}
                      </>
                    ) : (
                      translate('auto.components.settings.shortcut.integration.card.test', 'Test')
                    )}
                  </Button>
                  <button
                    onClick={() => void handleDisconnect(workspace.id)}
                    aria-label={translate(
                      'auto.components.settings.shortcut.integration.card.disconnectOne',
                      'Disconnect {{value0}}',
                      { value0: workspace.name }
                    )}
                    className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                  >
                    <Unlink className="size-3.5" />
                  </button>
                </div>
              )
            })}
            <p className="text-[11px] text-muted-foreground/70">
              {translate(
                'auto.components.settings.shortcut.integration.card.tokenPerWorkspace',
                'Each connected Shortcut workspace has one token stored by the active runtime.'
              )}
            </p>
          </div>
        ) : connected ? (
          <>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.shortcut.integration.card.staleList',
                'Shortcut is connected for this runtime. Re-check if the connected workspace list looks stale.'
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void checkShortcutConnection()}>
                {translate(
                  'auto.components.settings.shortcut.integration.card.recheck',
                  'Re-check'
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()}>
                {translate(
                  'auto.components.settings.shortcut.integration.card.disconnectAll',
                  'Disconnect'
                )}
              </Button>
            </div>
          </>
        ) : !checking ? (
          <>
            <p className="text-xs text-muted-foreground">{credentialCopy}</p>
            <Button variant="ghost" size="sm" onClick={() => void checkShortcutConnection()}>
              {translate('auto.components.settings.shortcut.integration.card.recheck', 'Re-check')}
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>

      <ShortcutConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResultByWorkspace({})}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
