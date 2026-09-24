import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { PlaneConnectDialog } from '@/components/plane-connect-dialog'
import { PlaneIcon } from '@/components/icons/PlaneIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { PLANE_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'

export function PlaneIntegrationCard(): React.JSX.Element {
  const planeStatus = useAppStore((s) => s.planeStatus)
  const planeStatusChecked = useAppStore((s) => s.planeStatusChecked)
  const checkPlaneConnection = useAppStore((s) => s.checkPlaneConnection)
  const disconnectPlane = useAppStore((s) => s.disconnectPlane)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const connected = planeStatus.connected
  const checking = !planeStatusChecked
  const workspaces = planeStatus.workspaces ?? []
  const workspaceCount = workspaces.length
  const activeWorkspace = workspaces.find((w) => w.slug === planeStatus.activeWorkspaceSlug)
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')

  useEffect(() => {
    if (!planeStatusChecked) {
      void checkPlaneConnection()
    }
  }, [planeStatusChecked, checkPlaneConnection])

  const handleDisconnect = async (): Promise<void> => {
    await disconnectPlane()
    if (mountedRef.current) {
      setTestResult(null)
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.plane.testConnection()
      if (mountedRef.current) {
        setTestResult(res)
      }
    } catch (err) {
      if (mountedRef.current) {
        setTestResult({
          ok: false,
          error: err instanceof Error ? err.message : 'Connection failed'
        })
      }
    } finally {
      if (mountedRef.current) {
        setTesting(false)
      }
    }
  }

  return (
    <IntegrationCardShell
      settingsSectionId={PLANE_INTEGRATION_SECTION_ID}
      icon={<PlaneIcon className="size-5" />}
      name="Plane"
      description={
        connected
          ? activeWorkspace
            ? `${activeWorkspace.name} (${activeWorkspace.slug})`
            : translate(
                'auto.components.settings.task.tracker.integration.cards.e1f5e6424c',
                '{{value0}} workspace{{value1}} connected',
                { value0: workspaceCount, value1: workspaceCount === 1 ? '' : 's' }
              )
          : checking
            ? translate(
                'auto.components.settings.task.tracker.integration.cards.checkingPlane',
                'Checking Plane access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.task.tracker.integration.cards.addPlaneAccess',
                'Connect Plane Cloud or a self-hosted instance using an API token.'
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
        connected ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleDisconnect}
          >
            <Unlink className="size-3.5" />
            {translate('common.disconnect', 'Disconnect')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => setDialogOpen(true)}
            disabled={checking}
          >
            {translate('common.connect', 'Connect')}
          </Button>
        )
      }
    >
      <IntegrationCardDetails>
        <div className="space-y-3 pt-1">
          {connected && (
            <div className={subordinateRowClass}>
              <div className="flex flex-1 items-center gap-2 text-xs">
                {planeStatus.viewer?.displayName && (
                  <span className="font-medium text-foreground">
                    {planeStatus.viewer.displayName}
                  </span>
                )}
                <span className="text-muted-foreground">
                  ({planeStatus.instanceUrl || 'Plane Cloud'})
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleTest}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <LoaderCircle className="mr-1 size-3 animate-spin" />
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
            </div>
          )}

          {testResult && (
            <div
              className={`flex items-center gap-1.5 text-xs ${
                testResult.ok ? 'text-emerald-500' : 'text-destructive'
              }`}
            >
              {testResult.ok ? (
                <>
                  <CheckCircle2 className="size-3.5" />
                  {translate(
                    'auto.components.settings.task.tracker.integration.cards.a2c0015fb8',
                    'Verified'
                  )}
                </>
              ) : (
                <>
                  <AlertCircle className="size-3.5" />
                  {testResult.error ||
                    translate(
                      'auto.components.settings.plane.connectionFailed',
                      'Connection failed'
                    )}
                </>
              )}
            </div>
          )}

          {planeStatus.credentialError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {planeStatus.credentialError}
            </div>
          )}

          <div className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.plane.cardFooter',
              'Browse issues and open worktrees with ticket context directly from Plane Cloud or your self-hosted instance.'
            )}
          </div>
        </div>
      </IntegrationCardDetails>

      <PlaneConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => {
          void checkPlaneConnection()
        }}
      />
    </IntegrationCardShell>
  )
}
