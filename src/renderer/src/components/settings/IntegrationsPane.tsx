import { useEffect, useState } from 'react'
import {
  Github,
  ExternalLink,
  LoaderCircle,
  Lock,
  Terminal,
  Unlink,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import type { SettingsSearchEntry } from './settings-search'

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

export const INTEGRATIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'GitHub Integration',
    description: 'GitHub authentication via the gh CLI.',
    keywords: ['github', 'gh', 'integration']
  },
  {
    title: 'Linear Integration',
    description: 'Connect Linear to browse and link issues.',
    keywords: ['linear', 'integration', 'api key', 'connect', 'disconnect']
  }
]

type GhStatus = 'checking' | 'connected' | 'not-installed' | 'not-authenticated'

export function IntegrationsPane(): React.JSX.Element {
  const linearStatus = useAppStore((s) => s.linearStatus)
  const connectLinear = useAppStore((s) => s.connectLinear)
  const disconnectLinear = useAppStore((s) => s.disconnectLinear)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const testLinearConnection = useAppStore((s) => s.testLinearConnection)

  const [ghStatus, setGhStatus] = useState<GhStatus>('checking')
  const [linearDialogOpen, setLinearDialogOpen] = useState(false)
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState('')
  const [linearConnectState, setLinearConnectState] = useState<'idle' | 'connecting' | 'error'>(
    'idle'
  )
  const [linearConnectError, setLinearConnectError] = useState<string | null>(null)
  const [linearTestState, setLinearTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>(
    'idle'
  )
  const [linearTestError, setLinearTestError] = useState<string | null>(null)

  useEffect(() => {
    void checkLinearConnection()
    void window.api.preflight.check().then((status) => {
      if (!status.gh.installed) {
        setGhStatus('not-installed')
      } else if (!status.gh.authenticated) {
        setGhStatus('not-authenticated')
      } else {
        setGhStatus('connected')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount check
  }, [])

  const handleLinearConnect = async (): Promise<void> => {
    if (!linearApiKeyDraft.trim()) {
      return
    }
    setLinearConnectState('connecting')
    setLinearConnectError(null)
    try {
      const result = await connectLinear(linearApiKeyDraft.trim())
      if (result.ok) {
        setLinearApiKeyDraft('')
        setLinearConnectState('idle')
        setLinearDialogOpen(false)
      } else {
        setLinearConnectState('error')
        setLinearConnectError(result.error)
      }
    } catch (error) {
      setLinearConnectState('error')
      setLinearConnectError(error instanceof Error ? error.message : 'Connection failed')
    }
  }

  const handleLinearDisconnect = async (): Promise<void> => {
    await disconnectLinear()
    setLinearConnectState('idle')
    setLinearConnectError(null)
    setLinearTestState('idle')
    setLinearTestError(null)
  }

  // Why: explicit user-triggered verification. This is the *only* path in
  // settings that decrypts the stored API key, so the macOS Keychain prompt
  // (if the app signature has changed since the item was stored) only
  // appears when the user clicks Test — not just for opening Settings.
  const handleLinearTest = async (): Promise<void> => {
    setLinearTestState('testing')
    setLinearTestError(null)
    const result = await testLinearConnection()
    if (result.ok) {
      setLinearTestState('ok')
    } else {
      setLinearTestState('error')
      setLinearTestError(result.error)
    }
  }

  const handleRefreshGh = (): void => {
    setGhStatus('checking')
    void window.api.preflight.check({ force: true }).then((status) => {
      if (!status.gh.installed) {
        setGhStatus('not-installed')
      } else if (!status.gh.authenticated) {
        setGhStatus('not-authenticated')
      } else {
        setGhStatus('connected')
      }
    })
  }

  return (
    <div className="space-y-3">
      {/* GitHub */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <Github className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">GitHub</p>
            <p className="text-xs text-muted-foreground">
              Pull requests, issues, and checks via the{' '}
              <span className="font-mono text-[11px]">gh</span> CLI.
            </p>
          </div>
          {ghStatus === 'checking' ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : ghStatus === 'connected' ? (
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              Connected
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {ghStatus === 'not-installed' ? 'Not installed' : 'Not authenticated'}
            </span>
          )}
        </div>

        {ghStatus !== 'checking' && ghStatus !== 'connected' && (
          <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5 space-y-2">
            {ghStatus === 'not-installed' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Install the GitHub CLI to enable pull requests, issues, and checks.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.api.shell.openUrl('https://cli.github.com')}
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    Install GitHub CLI
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGh}>
                    Re-check
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  The GitHub CLI is installed but not authenticated. Run this command in a terminal:
                </p>
                <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs">
                  <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                  gh auth login
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl('https://cli.github.com/manual/gh_auth_login')
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    Learn more
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGh}>
                    Re-check
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Linear */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <LinearIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">Linear</p>
            <p className="text-xs text-muted-foreground">
              {linearStatus.connected
                ? linearStatus.viewer
                  ? `${linearStatus.viewer.organizationName} · ${linearStatus.viewer.displayName}${linearStatus.viewer.email ? ` · ${linearStatus.viewer.email}` : ''}`
                  : 'API key saved. Test to verify.'
                : 'Browse and link issues to workspaces.'}
            </p>
          </div>
          {linearStatus.connected ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={handleLinearDisconnect}
                aria-label="Disconnect Linear"
                className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
              >
                <Unlink className="size-3.5" />
              </button>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                Connected
              </span>
            </div>
          ) : (
            <button
              className="shrink-0 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setLinearDialogOpen(true)}
            >
              Connect
            </button>
          )}
        </div>

        {linearStatus.connected && (
          <div className="mt-2.5 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleLinearTest()}
              disabled={linearTestState === 'testing'}
            >
              {linearTestState === 'testing' ? (
                <>
                  <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                  Testing…
                </>
              ) : (
                'Test connection'
              )}
            </Button>
            {linearTestState === 'ok' && (
              <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                Verified
              </span>
            )}
            {linearTestState === 'error' && linearTestError && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="size-3.5" />
                {linearTestError}
              </span>
            )}
            {linearTestState === 'idle' && (
              <span className="text-[11px] text-muted-foreground/70">
                Verifies your API key against Linear.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Linear Connect Dialog */}
      <Dialog
        open={linearDialogOpen}
        onOpenChange={(open) => {
          if (linearConnectState !== 'connecting') {
            setLinearDialogOpen(open)
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              linearApiKeyDraft.trim() &&
              linearConnectState !== 'connecting'
            ) {
              e.preventDefault()
              void handleLinearConnect()
            }
          }}
        >
          <DialogHeader className="gap-3">
            <DialogTitle className="leading-tight">Connect Linear</DialogTitle>
            <DialogDescription>
              Paste a <strong className="font-semibold text-foreground">Personal API key</strong> to
              browse your assigned issues.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              type="password"
              placeholder="lin_api_..."
              value={linearApiKeyDraft}
              onChange={(e) => {
                setLinearApiKeyDraft(e.target.value)
                if (linearConnectState === 'error') {
                  setLinearConnectState('idle')
                  setLinearConnectError(null)
                }
              }}
              disabled={linearConnectState === 'connecting'}
            />
            {linearConnectState === 'error' && linearConnectError && (
              <p className="text-xs text-destructive">{linearConnectError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Create one in{' '}
              <button
                className="text-primary underline-offset-2 hover:underline"
                onClick={() =>
                  window.api.shell.openUrl('https://linear.app/settings/account/security')
                }
              >
                Linear Settings → Security
              </button>{' '}
              → <strong className="font-semibold text-foreground">New API key</strong> (not{' '}
              <span className="text-foreground">New passkey</span>).
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              Your key is encrypted via the OS keychain and stored locally.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLinearDialogOpen(false)}
              disabled={linearConnectState === 'connecting'}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleLinearConnect()}
              disabled={!linearApiKeyDraft.trim() || linearConnectState === 'connecting'}
            >
              {linearConnectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                'Connect'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
