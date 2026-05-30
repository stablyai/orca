import { useEffect, useState } from 'react'
import { ExternalLink, Github, Terminal } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { Button } from '@/components/ui/button'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { useAppStore } from '@/store'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
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

export function GitHubRow(props: { compact?: boolean } = {}): React.JSX.Element {
  const { compact = false } = props
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)

  const state: GitHubSetupState = preflightStatusLoading
    ? 'checking'
    : getGitHubSetupState(preflightStatus)
  const [githubTerminalOpen, setGithubTerminalOpen] = useState(false)

  return (
    <div className="rounded-xl border border-border bg-muted/20">
      <div className={cn(compact ? 'flex flex-col gap-3 p-4' : 'flex items-start gap-4 p-5')}>
        <div className={cn('flex items-start gap-3', compact ? '' : 'gap-4 flex-1 min-w-0')}>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
            <Github className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold leading-tight text-foreground">GitHub</h3>
              {state === 'connected' ? (
                <IntegrationStatusPill tone="connected">Connected</IntegrationStatusPill>
              ) : state === 'not-installed' ? (
                <IntegrationStatusPill tone="attention">CLI not installed</IntegrationStatusPill>
              ) : state === 'not-authenticated' ? (
                <IntegrationStatusPill tone="attention">Sign in needed</IntegrationStatusPill>
              ) : (
                <IntegrationStatusPill tone="neutral">Checking…</IntegrationStatusPill>
              )}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Pull requests, issues, and check status.
            </p>
          </div>
        </div>
        <div className={cn('flex items-center gap-2', compact ? 'flex-wrap' : 'shrink-0')}>
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
          {state !== 'connected' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshPreflightStatus({ force: true })}
            >
              Re-check
            </Button>
          ) : null}
        </div>
      </div>
      {state === 'not-authenticated' && githubTerminalOpen ? (
        <div className={cn(compact ? 'px-4 pb-4' : 'px-5 pb-5')}>
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

export function LinearRow(props: { compact?: boolean } = {}): React.JSX.Element {
  const { compact = false } = props
  const linearStatus = useAppStore((s) => s.linearStatus)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)

  const [dialogOpen, setDialogOpen] = useState(false)

  const workspaceCount = linearStatus.workspaces?.length ?? (linearStatus.connected ? 1 : 0)

  return (
    <>
      <div className="rounded-xl border border-border bg-muted/20">
        <div className={cn(compact ? 'flex flex-col gap-3 p-4' : 'flex items-start gap-4 p-5')}>
          <div className={cn('flex items-start gap-3', compact ? '' : 'gap-4 flex-1 min-w-0')}>
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
              <LinearIcon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-semibold leading-tight text-foreground">Linear</h3>
                {linearStatus.connected ? (
                  <IntegrationStatusPill tone="connected">Connected</IntegrationStatusPill>
                ) : null}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {linearStatus.connected
                  ? `${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'} linked. Update restricted access any time.`
                  : 'Add Linear access with a Personal API key. Full-access keys can show every team the key owner can access.'}
              </p>
            </div>
          </div>
          <div className={cn('flex items-center gap-2', compact ? 'flex-wrap' : 'shrink-0')}>
            {linearStatus.connected ? (
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
                Update access
              </Button>
            ) : (
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                Add Linear access
              </Button>
            )}
            {!linearStatus.connected ? (
              <Button variant="ghost" size="sm" onClick={() => void checkLinearConnection(true)}>
                Re-check
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <LinearApiKeyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
        connectLabel={linearStatus.connected ? 'Update access' : 'Add Linear access'}
      />
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
          <IntegrationStatusPill tone="neutral">Coming soon</IntegrationStatusPill>
        </div>
      </div>
    </div>
  )
}
