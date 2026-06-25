import { useEffect, useState } from 'react'
import { ExternalLink, Github, Terminal } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { Button } from '@/components/ui/button'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { useAppStore } from '@/store'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { cn } from '@/lib/utils'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import { translate } from '@/i18n/i18n'

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
              <h3 className="text-[15px] font-semibold leading-tight text-foreground">
                {translate('auto.components.onboarding.IntegrationsStep.217beb0658', 'GitHub')}
              </h3>
              {state === 'connected' ? (
                <IntegrationStatusPill tone="connected">
                  {translate('auto.components.onboarding.IntegrationsStep.c91a5782f1', 'Connected')}
                </IntegrationStatusPill>
              ) : state === 'not-installed' ? (
                <IntegrationStatusPill tone="attention">
                  {translate(
                    'auto.components.onboarding.IntegrationsStep.5c115cb713',
                    'CLI not installed'
                  )}
                </IntegrationStatusPill>
              ) : state === 'not-authenticated' ? (
                <IntegrationStatusPill tone="attention">
                  {translate(
                    'auto.components.onboarding.IntegrationsStep.8405043962',
                    'Sign in needed'
                  )}
                </IntegrationStatusPill>
              ) : (
                <IntegrationStatusPill tone="neutral">
                  {translate('auto.components.onboarding.IntegrationsStep.c1547656f0', 'Checking…')}
                </IntegrationStatusPill>
              )}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.onboarding.IntegrationsStep.50db38cf4b',
                'Pull requests, issues, and check status.'
              )}
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
              {translate('auto.components.onboarding.IntegrationsStep.bd5d976fb2', 'Install gh')}
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
              {githubTerminalOpen
                ? translate('auto.components.onboarding.IntegrationsStep.0b4a7d23ab', 'Signing in')
                : translate('auto.components.onboarding.IntegrationsStep.d6e5dba05a', 'Sign in')}
            </Button>
          ) : null}
          {state !== 'connected' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshPreflightStatus({ force: true })}
            >
              {translate('auto.components.onboarding.IntegrationsStep.80e3ce0bc9', 'Re-check')}
            </Button>
          ) : null}
        </div>
      </div>
      {state === 'not-authenticated' && githubTerminalOpen ? (
        <div className={cn(compact ? 'px-4 pb-4' : 'px-5 pb-5')}>
          <OnboardingInlineCommandTerminal
            command="gh auth login"
            title={translate(
              'auto.components.onboarding.IntegrationsStep.6d469169f2',
              'GitHub setup'
            )}
            ariaLabel={translate(
              'auto.components.onboarding.IntegrationsStep.f9d2e12d17',
              'GitHub sign in command'
            )}
            description={translate(
              'auto.components.onboarding.IntegrationsStep.af69f42372',
              'Press Enter to run GitHub CLI auth. Re-check GitHub after the browser or device flow finishes.'
            )}
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
                <h3 className="text-[15px] font-semibold leading-tight text-foreground">
                  {translate('auto.components.onboarding.IntegrationsStep.27743304b1', 'Linear')}
                </h3>
                {linearStatus.connected ? (
                  <IntegrationStatusPill tone="connected">
                    {translate(
                      'auto.components.onboarding.IntegrationsStep.c91a5782f1',
                      'Connected'
                    )}
                  </IntegrationStatusPill>
                ) : null}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {linearStatus.connected
                  ? translate(
                      'auto.components.onboarding.IntegrationsStep.b08a6ac93c',
                      '{{value0}} workspace{{value1}} linked. Add another workspace or replace a restricted key any time.',
                      { value0: workspaceCount, value1: workspaceCount === 1 ? '' : 's' }
                    )
                  : translate(
                      'auto.components.onboarding.IntegrationsStep.4983ae7433',
                      'Add Linear access with a Personal API key. Full-access keys can show every team the key owner can access.'
                    )}
              </p>
            </div>
          </div>
          <div className={cn('flex items-center gap-2', compact ? 'flex-wrap' : 'shrink-0')}>
            {linearStatus.connected ? (
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
                {translate(
                  'auto.components.onboarding.IntegrationsStep.dd9c186a8b',
                  'Add workspace access'
                )}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                {translate(
                  'auto.components.onboarding.IntegrationsStep.04ef416712',
                  'Add Linear access'
                )}
              </Button>
            )}
            {!linearStatus.connected ? (
              <Button variant="ghost" size="sm" onClick={() => void checkLinearConnection(true)}>
                {translate('auto.components.onboarding.IntegrationsStep.80e3ce0bc9', 'Re-check')}
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
        connectLabel="Add Linear access"
      />
    </>
  )
}

const CAPABILITIES = [
  'Start a workspace from any GitHub issue or pull request, prefilled with its title and context',
  'Browse GitHub issues and pull requests in the Tasks view without leaving Orca',
  'See issue state, review status, and CI checks on every worktree',
  'Read, comment on, and merge pull requests without leaving Orca'
] as const

export function IntegrationsStep(): React.JSX.Element {
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)

  useEffect(() => {
    void refreshPreflightStatus()
  }, [refreshPreflightStatus])

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
        <div className="mt-4 rounded-xl border border-border bg-muted/10 px-5 py-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[14px] font-medium text-foreground/70">
              {translate(
                'auto.components.onboarding.IntegrationsStep.3a3e360289',
                'More task sources'
              )}
            </span>
            <span className="text-[13px] leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.onboarding.IntegrationsStep.277f30eb34',
                'Linear, GitLab, Bitbucket, Azure DevOps, Gitea, and Jira live in Settings > Integrations.'
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
