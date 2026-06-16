import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, Lock, LoaderCircle, Unlink } from 'lucide-react'
import { AsanaIcon } from '@/components/icons/AsanaIcon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { AsanaWorkspace } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'

type AsanaTestResult = { state: 'ok' | 'error'; error?: string }

function getAsanaWorkspaceSubtitle(workspace: AsanaWorkspace): string {
  return workspace.userEmail ? `${workspace.userName} · ${workspace.userEmail}` : workspace.userName
}

export function AsanaIntegrationCard(): React.JSX.Element {
  const asanaStatus = useAppStore((s) => s.asanaStatus)
  const checkAsanaConnection = useAppStore((s) => s.checkAsanaConnection)
  const connectAsana = useAppStore((s) => s.connectAsana)
  const disconnectAsana = useAppStore((s) => s.disconnectAsana)
  const testAsanaConnection = useAppStore((s) => s.testAsanaConnection)
  const mountedRef = useMountedRef()

  const [formOpen, setFormOpen] = useState(false)
  const [apiTokenDraft, setApiTokenDraft] = useState('')
  const [connectState, setConnectState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)
  const [testingWorkspaceIds, setTestingWorkspaceIds] = useState<Set<string>>(new Set())
  const [testResultByWorkspace, setTestResultByWorkspace] = useState<
    Record<string, AsanaTestResult>
  >({})

  const asanaWorkspaces = asanaStatus.workspaces ?? []

  useEffect(() => {
    void checkAsanaConnection()
  }, [checkAsanaConnection])

  const openForm = (): void => {
    setFormOpen(true)
    setApiTokenDraft('')
    setConnectState('idle')
    setConnectError(null)
  }

  const closeForm = (): void => {
    if (connectState === 'connecting') {
      return
    }
    setFormOpen(false)
    setConnectError(null)
    setConnectState('idle')
  }

  const handleConnect = async (): Promise<void> => {
    const apiToken = apiTokenDraft.trim()
    if (!apiToken) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    const result = await connectAsana({ apiToken })
    if (!mountedRef.current) {
      return
    }
    if (result.ok) {
      setFormOpen(false)
      setApiTokenDraft('')
      setConnectState('idle')
      setTestResultByWorkspace({})
      return
    }
    setConnectState('error')
    setConnectError(result.error)
  }

  const handleTest = async (workspaceId: string): Promise<void> => {
    // Why: track in-flight tests per workspace so concurrent tests don't clear
    // each other's loading state.
    setTestingWorkspaceIds((prev) => new Set(prev).add(workspaceId))
    setTestResultByWorkspace((prev) => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
    try {
      const result = await testAsanaConnection(workspaceId)
      if (!mountedRef.current) {
        return
      }
      setTestResultByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
      }))
    } finally {
      if (mountedRef.current) {
        setTestingWorkspaceIds((prev) => {
          const next = new Set(prev)
          next.delete(workspaceId)
          return next
        })
      }
    }
  }

  const handleDisconnect = async (workspaceId: string): Promise<void> => {
    await disconnectAsana(workspaceId)
    if (!mountedRef.current) {
      return
    }
    setTestResultByWorkspace((prev) => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
  }

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3">
        <AsanaIcon className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            {translate('auto.components.settings.asana.integration.card.c85ef21457', 'Asana')}
          </p>
          <p className="text-xs text-muted-foreground">
            {asanaStatus.connected
              ? translate(
                  'auto.components.settings.asana.integration.card.6fcf15da92',
                  '{{count}} workspace{{suffix}} connected',
                  { count: asanaWorkspaces.length, suffix: asanaWorkspaces.length === 1 ? '' : 's' }
                )
              : translate(
                  'auto.components.settings.asana.integration.card.5606735ec4',
                  'Connect Asana with a Personal Access Token to browse, create, and link tasks.'
                )}
          </p>
        </div>
        {asanaStatus.connected ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={openForm}>
              {translate('auto.components.settings.asana.integration.card.b27685f5c1', 'Reconnect')}
            </Button>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {translate('auto.components.settings.asana.integration.card.92478056f1', 'Connected')}
            </span>
          </div>
        ) : (
          <button
            className="shrink-0 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={openForm}
          >
            {translate(
              'auto.components.settings.asana.integration.card.ea71ac55e3',
              'Connect Asana'
            )}
          </button>
        )}
      </div>

      {formOpen ? (
        <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5">
          <Input
            autoFocus
            type="password"
            placeholder={translate(
              'auto.components.settings.asana.integration.card.48d26a9e60',
              'Asana Personal Access Token'
            )}
            value={apiTokenDraft}
            onChange={(e) => {
              setApiTokenDraft(e.target.value)
              setConnectError(null)
              setConnectState('idle')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && apiTokenDraft.trim() && connectState !== 'connecting') {
                e.preventDefault()
                void handleConnect()
              }
            }}
            disabled={connectState === 'connecting'}
          />
          {connectState === 'error' && connectError ? (
            <p className="mt-2 text-xs text-destructive">{connectError}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => window.api.shell.openUrl('https://app.asana.com/0/my-apps')}
            >
              <ExternalLink className="size-3.5" />
              {translate(
                'auto.components.settings.asana.integration.card.c7fb4f4eb6',
                'Create a Personal Access Token'
              )}
            </button>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={closeForm}
                disabled={connectState === 'connecting'}
              >
                {translate('auto.components.settings.asana.integration.card.62dff4dbad', 'Cancel')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleConnect()}
                disabled={!apiTokenDraft.trim() || connectState === 'connecting'}
              >
                {connectState === 'connecting' ? (
                  <>
                    <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                    {translate(
                      'auto.components.settings.asana.integration.card.47677169c2',
                      'Verifying…'
                    )}
                  </>
                ) : (
                  translate('auto.components.settings.asana.integration.card.2e722b4f81', 'Connect')
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {asanaStatus.connected ? (
        <div className="mt-3 space-y-2">
          {asanaWorkspaces.map((workspace) => {
            const testResult = testResultByWorkspace[workspace.id]
            const testing = testingWorkspaceIds.has(workspace.id)
            return (
              <div
                key={workspace.id}
                className="flex items-center gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{workspace.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {getAsanaWorkspaceSubtitle(workspace)}
                  </p>
                </div>
                {testResult?.state === 'ok' ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5" />
                    {translate(
                      'auto.components.settings.asana.integration.card.d51fefc10b',
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
                        'auto.components.settings.asana.integration.card.24e507c8bf',
                        'Testing…'
                      )}
                    </>
                  ) : (
                    translate('auto.components.settings.asana.integration.card.90428fc2cc', 'Test')
                  )}
                </Button>
                <button
                  onClick={() => void handleDisconnect(workspace.id)}
                  aria-label={translate(
                    'auto.components.settings.asana.integration.card.7fde3c624d',
                    'Disconnect {{name}}',
                    { name: workspace.name }
                  )}
                  className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                >
                  <Unlink className="size-3.5" />
                </button>
              </div>
            )
          })}
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Lock className="size-3 shrink-0" />
            {translate(
              'auto.components.settings.asana.integration.card.b9c92b30a6',
              'Asana tokens are encrypted by the active runtime and stored locally. Reconnecting with a new token replaces the stored credentials for every workspace.'
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
