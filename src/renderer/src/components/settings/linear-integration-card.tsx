import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

export function LinearIntegrationCard(): React.JSX.Element {
  const linearStatus = useAppStore((s) => s.linearStatus)
  const disconnectLinear = useAppStore((s) => s.disconnectLinear)
  const disconnectLinearWorkspace = useAppStore((s) => s.disconnectLinearWorkspace)
  const testLinearConnection = useAppStore((s) => s.testLinearConnection)
  const linearWorkspaces = linearStatus.workspaces ?? []
  const mountedRef = useMountedRef()

  const [linearDialogOpen, setLinearDialogOpen] = useState(false)
  const [linearTestingWorkspaceId, setLinearTestingWorkspaceId] = useState<string | null>(null)
  const [linearTestResultByWorkspace, setLinearTestResultByWorkspace] = useState<
    Record<string, { state: 'ok' | 'error'; error?: string }>
  >({})

  const handleLinearDisconnect = async (workspaceId?: string): Promise<void> => {
    await (workspaceId ? disconnectLinearWorkspace(workspaceId) : disconnectLinear())
    if (!mountedRef.current) {
      return
    }
    setLinearTestResultByWorkspace({})
  }

  // Why: explicit user-triggered verification is the only settings path that
  // decrypts the stored API key, avoiding surprise Keychain prompts on open.
  const handleLinearTest = async (workspaceId: string): Promise<void> => {
    setLinearTestingWorkspaceId(workspaceId)
    setLinearTestResultByWorkspace((prev) => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
    const result = await testLinearConnection(workspaceId)
    if (!mountedRef.current) {
      return
    }
    if (result.ok) {
      setLinearTestResultByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: { state: 'ok' }
      }))
    } else {
      setLinearTestResultByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: { state: 'error', error: result.error }
      }))
    }
    setLinearTestingWorkspaceId(null)
  }

  return (
    <>
      {/* Linear */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <LinearIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {translate('auto.components.settings.IntegrationsPane.264a9b6128', 'Linear')}
            </p>
            <p className="text-xs text-muted-foreground">
              {linearStatus.connected
                ? translate(
                    'auto.components.settings.IntegrationsPane.98ded79cd7',
                    '{{value0}} workspace{{value1}} connected',
                    {
                      value0: linearWorkspaces.length,
                      value1: linearWorkspaces.length === 1 ? '' : 's'
                    }
                  )
                : translate(
                    'auto.components.settings.IntegrationsPane.33ae9730a8',
                    'Add Linear access to browse and link issues.'
                  )}
            </p>
            {linearStatus.credentialError ? (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="size-3.5 shrink-0" />
                <span className="min-w-0">{linearStatus.credentialError}</span>
              </p>
            ) : null}
          </div>
          {linearStatus.connected ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setLinearDialogOpen(true)}>
                {translate(
                  'auto.components.settings.IntegrationsPane.077844591a',
                  'Add workspace access'
                )}
              </Button>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                {translate('auto.components.settings.IntegrationsPane.6432f6522e', 'Connected')}
              </span>
            </div>
          ) : (
            <button
              className="shrink-0 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setLinearDialogOpen(true)}
            >
              {translate(
                'auto.components.settings.IntegrationsPane.f5c5246514',
                'Add Linear access'
              )}
            </button>
          )}
        </div>

        {linearStatus.connected && (
          <div className="mt-3 space-y-2">
            {linearWorkspaces.map((workspace) => {
              const testResult = linearTestResultByWorkspace[workspace.id]
              const testing = linearTestingWorkspaceId === workspace.id
              return (
                <div
                  key={workspace.id}
                  className="flex items-center gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
                >
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
                    <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3.5" />
                      {translate(
                        'auto.components.settings.IntegrationsPane.fe4d378dc4',
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
                    onClick={() => void handleLinearTest(workspace.id)}
                    disabled={testing}
                  >
                    {testing ? (
                      <>
                        <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                        {translate(
                          'auto.components.settings.IntegrationsPane.e7b2dd46f9',
                          'Testing…'
                        )}
                      </>
                    ) : (
                      translate('auto.components.settings.IntegrationsPane.95b9a87e7e', 'Test')
                    )}
                  </Button>
                  <button
                    onClick={() => void handleLinearDisconnect(workspace.id)}
                    aria-label={translate(
                      'auto.components.settings.IntegrationsPane.8e078e480c',
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
                'auto.components.settings.IntegrationsPane.2122e15517',
                'Each connected Linear workspace has one key stored by the active runtime. Full-access keys can cover all teams the key owner can access; restricted keys can be replaced any time.'
              )}
            </p>
          </div>
        )}
      </div>
      <LinearApiKeyDialog
        open={linearDialogOpen}
        onOpenChange={setLinearDialogOpen}
        connectLabel="Add Linear access"
        onConnected={() => setLinearTestResultByWorkspace({})}
      />
    </>
  )
}
