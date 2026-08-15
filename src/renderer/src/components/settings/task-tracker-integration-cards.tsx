import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { PlaneIcon } from '@/components/icons/PlaneIcon'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { PlaneApiKeyDialog } from '@/components/plane-api-key-dialog'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { LinearAgentSkillInstallCta } from './linear-agent-skill-install-cta'
import { getProviderAccountScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { LINEAR_INTEGRATION_SECTION_ID, PLANE_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function LinearIntegrationCard(): React.JSX.Element {
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const disconnectLinear = useAppStore((s) => s.disconnectLinear)
  const disconnectLinearWorkspace = useAppStore((s) => s.disconnectLinearWorkspace)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const testLinearConnection = useAppStore((s) => s.testLinearConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingWorkspaceId, setTestingWorkspaceId] = useState<string | null>(null)
  const [testResultByWorkspace, setTestResultByWorkspace] = useState<
    Record<string, VerificationResult>
  >({})

  const contextMatches = linearStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !linearStatusChecked
  const connected = contextMatches && linearStatus.connected
  const workspaces = linearStatus.workspaces ?? []
  const accountScope = getProviderAccountScope(settings)
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')

  const handleDisconnect = async (workspaceId?: string): Promise<void> => {
    await (workspaceId ? disconnectLinearWorkspace(workspaceId) : disconnectLinear())
    if (mountedRef.current) {
      setTestResultByWorkspace({})
    }
  }

  // Why: explicit user-triggered verification. This is the only settings path
  // that decrypts a stored Linear key, avoiding surprise keychain prompts.
  const handleTest = async (workspaceId: string): Promise<void> => {
    setTestingWorkspaceId(workspaceId)
    setTestResultByWorkspace((prev) => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
    const result = await testLinearConnection(workspaceId)
    if (!mountedRef.current) {
      return
    }
    setTestResultByWorkspace((prev) => ({
      ...prev,
      [workspaceId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
    }))
    setTestingWorkspaceId(null)
  }

  return (
    <IntegrationCardShell
      settingsSectionId={LINEAR_INTEGRATION_SECTION_ID}
      icon={<LinearIcon className="size-5" />}
      name="Linear"
      description={
        connected
          ? translate(
              'auto.components.settings.task.tracker.integration.cards.e1f5e6424c',
              '{{value0}} workspace{{value1}} connected',
              { value0: workspaces.length, value1: workspaces.length === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.task.tracker.integration.cards.fe9231215b',
                'Checking Linear access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.task.tracker.integration.cards.eae4a9f16b',
                'Add Linear access to browse and link issues.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate(
              'auto.components.settings.task.tracker.integration.cards.statusConnected',
              'Connected'
            )
          : translate(
              'auto.components.settings.task.tracker.integration.cards.statusNotConnected',
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
                  'auto.components.settings.task.tracker.integration.cards.622c224082',
                  'Add workspace access'
                )
              : translate(
                  'auto.components.settings.task.tracker.integration.cards.1a12e33fe5',
                  'Add Linear access'
                )}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <ProviderAccountScopeRow scope={accountScope} />
        {connected ? (
          <div className="space-y-2">
            {workspaces.map((workspace) => {
              const testResult = testResultByWorkspace[workspace.id]
              const testing = testingWorkspaceId === workspace.id
              return (
                <div key={workspace.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {workspace.organizationName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {workspace.displayName}
                      {workspace.email ? ` · ${workspace.email}` : ''}
                    </p>
                  </div>
                  {testResult?.state === 'ok' ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                      <CheckCircle2 className="size-3.5" />
                      {translate(
                        'auto.components.settings.task.tracker.integration.cards.a2c0015fb8',
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
                          'auto.components.settings.task.tracker.integration.cards.3e7c10d286',
                          'Testing...'
                        )}
                      </>
                    ) : (
                      translate(
                        'auto.components.settings.task.tracker.integration.cards.c24e56c532',
                        'Test'
                      )
                    )}
                  </Button>
                  <button
                    onClick={() => void handleDisconnect(workspace.id)}
                    aria-label={translate(
                      'auto.components.settings.task.tracker.integration.cards.dd3529015d',
                      'Disconnect {{value0}}',
                      { value0: workspace.organizationName }
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
                'auto.components.settings.task.tracker.integration.cards.6224fe9d34',
                'Each connected Linear workspace has one key stored by the active runtime. Full-access keys can cover all teams the key owner can access; restricted keys can be replaced any time.'
              )}
            </p>
          </div>
        ) : !checking ? (
          <>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.task.tracker.integration.cards.cef18762a2',
                'Add access with a Personal API key from your Linear settings. Full-access keys can see every team the key owner can reach.'
              )}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void checkLinearConnection(true)}>
              {translate(
                'auto.components.settings.task.tracker.integration.cards.c90f2ef419',
                'Re-check'
              )}
            </Button>
          </>
        ) : null}
        <LinearAgentSkillInstallCta settings={settings} />
      </IntegrationCardDetails>

      <LinearApiKeyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connectLabel="Add Linear access"
        onConnected={() => setTestResultByWorkspace({})}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}

function ProviderAccountScopeRow({ scope }: { scope: ReturnType<typeof getProviderAccountScope> }) {
  const subordinateRowClass = useIntegrationSubordinateRowClass('text-xs')

  return (
    <ProviderHostScopeControl
      labelPrefix={translate(
        'auto.components.settings.task.tracker.integration.cards.account_scope_prefix',
        'Account scope'
      )}
      scope={scope}
      className={subordinateRowClass}
    />
  )
}

export { JiraIntegrationCard } from './jira-integration-card'

export function PlaneIntegrationCard(): React.JSX.Element {
  const planeStatus = useAppStore((s) => s.planeStatus)
  const planeStatusChecked = useAppStore((s) => s.planeStatusChecked)
  const planeStatusContextKey = useAppStore((s) => s.planeStatusContextKey)
  const disconnectPlane = useAppStore((s) => s.disconnectPlane)
  const checkPlaneConnection = useAppStore((s) => s.checkPlaneConnection)
  const testPlaneConnection = useAppStore((s) => s.testPlaneConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingInstanceId, setTestingInstanceId] = useState<string | null>(null)
  const [testResultByInstance, setTestResultByInstance] = useState<Record<string, VerificationResult>>({})

  const contextMatches = planeStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !planeStatusChecked
  const connected = contextMatches && planeStatus.connected
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')

  const handleTest = async (instanceId: string): Promise<void> => {
    setTestingInstanceId(instanceId)
    setTestResultByInstance((prev) => {
      const next = { ...prev }
      delete next[instanceId]
      return next
    })
    const result = await testPlaneConnection(instanceId)
    if (!mountedRef.current) {
      return
    }
    setTestResultByInstance((prev) => ({
      ...prev,
      [instanceId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
    }))
    setTestingInstanceId(null)
  }

  const handleDisconnect = async (instanceId?: string): Promise<void> => {
    await disconnectPlane(instanceId)
    if (mountedRef.current) {
      setTestResultByInstance({})
    }
  }

  return (
    <IntegrationCardShell
      settingsSectionId={PLANE_INTEGRATION_SECTION_ID}
      icon={<PlaneIcon className="size-5" />}
      name="Plane"
      description={
        connected
          ? `${planeStatus.instances.length} instance${planeStatus.instances.length === 1 ? '' : 's'} connected`
          : checking
            ? 'Checking Plane access before showing setup actions.'
            : 'Add self-hosted or cloud Plane access to browse and link work items.'
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={connected ? 'Connected' : 'Not connected'}
      actions={
        !checking ? (
          <Button variant={connected ? 'outline' : 'default'} size="sm" onClick={() => setDialogOpen(true)}>
            {connected ? 'Add instance' : 'Add Plane access'}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <ProviderAccountScopeRow scope={getProviderAccountScope(settings)} />
        {connected ? (
          <div className="space-y-2">
            {planeStatus.instances.map((instance) => {
              const testResult = testResultByInstance[instance.id]
              const testing = testingInstanceId === instance.id
              return (
                <div key={instance.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{instance.workspaceSlug}</p>
                    <p className="truncate text-xs text-muted-foreground">{instance.baseUrl}</p>
                  </div>
                  {testResult?.state === 'ok' ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                      <CheckCircle2 className="size-3.5" /> Verified
                    </span>
                  ) : null}
                  {testResult?.state === 'error' ? (
                    <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-destructive">
                      <AlertCircle className="size-3.5 shrink-0" />
                      <span className="truncate">{testResult.error}</span>
                    </span>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => void handleTest(instance.id)} disabled={testing}>
                    {testing ? <LoaderCircle className="size-3.5 mr-1.5 animate-spin" /> : null}
                    {testing ? 'Testing...' : 'Test'}
                  </Button>
                  <button
                    onClick={() => void handleDisconnect(instance.id)}
                    aria-label={`Disconnect ${instance.workspaceSlug}`}
                    className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                  >
                    <Unlink className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        ) : !checking ? (
          <>
            <p className="text-xs text-muted-foreground">
              Add a Plane base URL, workspace slug, and Personal Access Token. Tokens are stored by the active runtime.
            </p>
            <Button variant="ghost" size="sm" onClick={() => void checkPlaneConnection(true)}>
              Re-check
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>
      <PlaneApiKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </IntegrationCardShell>
  )
}
