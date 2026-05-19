import { useEffect, useState } from 'react'
import { ExternalLink, Github, Loader2, Terminal } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
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
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'

type GitHubSetupState = 'checking' | 'connected' | 'not-installed' | 'not-authenticated'

function getGitHubSetupState(
  status: ReturnType<typeof useAppStore.getState>['preflightStatus']
): GitHubSetupState {
  if (!status) {
    return 'checking'
  }
  if (!status.gh.installed) {
    return 'not-installed'
  }
  return status.gh.authenticated ? 'connected' : 'not-authenticated'
}

type StatusTone = 'connected' | 'attention' | 'neutral'

const statusToneClassNames: Record<StatusTone, { pill: string; dot: string }> = {
  connected: {
    pill: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    dot: 'bg-emerald-500'
  },
  attention: {
    pill: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500'
  },
  neutral: {
    pill: 'border-border bg-background text-muted-foreground',
    dot: 'bg-muted-foreground'
  }
}

function StatusPill({
  tone,
  children
}: {
  tone: StatusTone
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        statusToneClassNames[tone].pill
      )}
    >
      <span className={cn('size-1.5 rounded-full', statusToneClassNames[tone].dot)} />
      {children}
    </span>
  )
}

function GitHubRow(): React.JSX.Element {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)

  const state: GitHubSetupState = preflightStatusLoading
    ? 'checking'
    : getGitHubSetupState(preflightStatus)
  const [githubTerminalOpen, setGithubTerminalOpen] = useState(false)

  return (
    <div className="rounded-xl border border-border bg-muted/20">
      <div className="flex items-start gap-4 p-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
          <Github className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold leading-tight text-foreground">GitHub</h3>
            {state === 'connected' ? (
              <StatusPill tone="connected">Connected</StatusPill>
            ) : state === 'not-installed' ? (
              <StatusPill tone="attention">CLI not installed</StatusPill>
            ) : state === 'not-authenticated' ? (
              <StatusPill tone="attention">Sign in needed</StatusPill>
            ) : (
              <StatusPill tone="neutral">Checking…</StatusPill>
            )}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Pull requests, issues, and check status.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state === 'not-installed' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.api.shell.openUrl('https://cli.github.com')}
            >
              <ExternalLink className="size-3.5" />
              Install gh
            </Button>
          ) : null}
          {state === 'not-authenticated' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={githubTerminalOpen}
              onClick={() => setGithubTerminalOpen(true)}
            >
              <Terminal className="size-3.5" />
              {githubTerminalOpen ? 'Signing in' : 'Sign in'}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshPreflightStatus({ force: true })}
          >
            Re-check
          </Button>
        </div>
      </div>
      {state === 'not-authenticated' && githubTerminalOpen ? (
        <div className="px-5 pb-5">
          <OnboardingInlineCommandTerminal
            command="gh auth login"
            title="GitHub setup"
            ariaLabel="GitHub sign in command"
            description="Press Enter to run GitHub CLI auth. Re-check GitHub after the browser or device flow finishes."
          />
        </div>
      ) : null}
    </div>
  )
}

function LinearRow(): React.JSX.Element {
  const linearStatus = useAppStore((s) => s.linearStatus)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const connectLinear = useAppStore((s) => s.connectLinear)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [connectState, setConnectState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  const workspaceCount = linearStatus.workspaces?.length ?? (linearStatus.connected ? 1 : 0)

  const handleConnect = async (): Promise<void> => {
    const apiKey = apiKeyDraft.trim()
    if (!apiKey || connectState === 'connecting') {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectLinear(apiKey)
      if (result.ok) {
        setApiKeyDraft('')
        setConnectState('idle')
        setDialogOpen(false)
        return
      }
      setConnectState('error')
      setConnectError(result.error)
    } catch (error) {
      setConnectState('error')
      setConnectError(error instanceof Error ? error.message : 'Connection failed')
    }
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-muted/20">
        <div className="flex items-start gap-4 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
            <LinearIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold leading-tight text-foreground">Linear</h3>
              {linearStatus.connected ? <StatusPill tone="connected">Connected</StatusPill> : null}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {linearStatus.connected
                ? `${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'} linked. Add another any time.`
                : 'Paste a Linear API key to link issues to workspaces. Stored locally; nothing leaves this machine.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {linearStatus.connected ? (
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
                Add workspace
              </Button>
            ) : (
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                Connect
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void checkLinearConnection(true)}>
              Re-check
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (connectState !== 'connecting') {
            setDialogOpen(open)
          }
        }}
      >
        <DialogContent
          overlayClassName="z-[110]"
          className="z-[120] sm:max-w-md"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && apiKeyDraft.trim() && connectState !== 'connecting') {
              event.preventDefault()
              void handleConnect()
            }
          }}
        >
          <DialogHeader className="gap-3">
            <DialogTitle className="leading-tight">Connect Linear workspace</DialogTitle>
            <DialogDescription>
              Paste a Personal API key to add a Linear workspace to Orca.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              autoFocus
              type="password"
              placeholder="lin_api_..."
              value={apiKeyDraft}
              onChange={(event) => {
                setApiKeyDraft(event.target.value)
                if (connectState === 'error') {
                  setConnectState('idle')
                  setConnectError(null)
                }
              }}
              disabled={connectState === 'connecting'}
            />
            {connectState === 'error' && connectError ? (
              <p className="text-xs text-destructive">{connectError}</p>
            ) : null}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Create one in{' '}
              <button
                className="text-primary underline-offset-2 hover:underline"
                onClick={() =>
                  window.api.shell.openUrl('https://linear.app/settings/account/security')
                }
              >
                Linear Settings &rarr; Security
              </button>
              .
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={connectState === 'connecting'}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleConnect()}
              disabled={!apiKeyDraft.trim() || connectState === 'connecting'}
            >
              {connectState === 'connecting' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                'Connect'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

const CAPABILITIES = [
  'Start a workspace from any issue, PR, or Linear ticket, prefilled with its title and context',
  'Browse your assigned tasks in the Tasks view without leaving Orca',
  'See issue state, PR review status, and CI checks on every worktree',
  'Read, comment on, and merge pull requests without leaving Orca'
] as const

export function IntegrationsStep(): React.JSX.Element {
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)

  useEffect(() => {
    void refreshPreflightStatus()
    void checkLinearConnection()
  }, [checkLinearConnection, refreshPreflightStatus])

  return (
    <div className="space-y-6">
      <ul className="-mt-6 space-y-1.5 text-[14px] leading-relaxed text-muted-foreground">
        {CAPABILITIES.map((line) => (
          <li key={line} className="flex gap-2.5">
            <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-3">
        <GitHubRow />
        <LinearRow />
        <div className="mt-4 flex items-center justify-between rounded-xl border border-border bg-muted/10 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="text-[14px] font-medium text-foreground/70">Jira</span>
            <span className="text-[13px] text-muted-foreground">
              Issues, sprints, and assignees.
            </span>
          </div>
          <StatusPill tone="neutral">Coming soon</StatusPill>
        </div>
      </div>
    </div>
  )
}
