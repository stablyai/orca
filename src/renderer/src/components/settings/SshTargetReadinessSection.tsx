import { useState } from 'react'
import { Copy, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type {
  SshReadinessCheck,
  SshReadinessCheckKey,
  SshReadinessReport,
  SshReadinessState
} from '../../../../shared/ssh-types'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { readinessStatusColor } from './ssh-status-color'

/** Sign-in commands that need an interactive terminal on the host itself: Orca
 *  cannot open one for an SSH target without creating a workspace there. */
const LOGIN_COMMANDS: Partial<Record<SshReadinessCheckKey, string>> = {
  claude: 'claude auth login',
  codex: 'codex login --device-auth',
  'gh-auth': 'gh auth login --web --git-protocol https'
}

function loginCommandFor(check: SshReadinessCheck): string | null {
  return check.state === 'miss' ? (LOGIN_COMMANDS[check.key] ?? null) : null
}

function checkLabel(key: SshReadinessCheckKey): string {
  switch (key) {
    case 'node':
      return translate('auto.components.settings.SshTargetReadinessSection.label.node', 'Node')
    case 'toolchain':
      return translate(
        'auto.components.settings.SshTargetReadinessSection.label.toolchain',
        'Toolchain'
      )
    case 'github':
      return translate('auto.components.settings.SshTargetReadinessSection.label.github', 'GitHub')
    case 'gh-auth':
      return translate(
        'auto.components.settings.SshTargetReadinessSection.label.ghAuth',
        'GitHub CLI auth'
      )
    case 'git-identity':
      return translate(
        'auto.components.settings.SshTargetReadinessSection.label.gitIdentity',
        'Git identity'
      )
    case 'claude':
      return translate('auto.components.settings.SshTargetReadinessSection.label.claude', 'Claude')
    case 'codex':
      return translate('auto.components.settings.SshTargetReadinessSection.label.codex', 'Codex')
  }
}

/** The dot carries the verdict by colour alone, so it needs a spoken fallback. */
function stateLabel(state: SshReadinessState): string {
  switch (state) {
    case 'ok':
      return translate('auto.components.settings.SshTargetReadinessSection.state.ok', 'Ready')
    case 'miss':
      return translate('auto.components.settings.SshTargetReadinessSection.state.miss', 'Missing')
    case 'unknown':
      return translate(
        'auto.components.settings.SshTargetReadinessSection.state.unknown',
        'Unknown'
      )
  }
}

function CopyLoginCommandButton({ command }: { command: string }): React.JSX.Element {
  const { copyText, status } = useClipboardTextCopyFeedback(command)

  const handleCopy = async (): Promise<void> => {
    if (await copyText()) {
      toast.success(
        translate(
          'auto.components.settings.SshTargetReadinessSection.loginCommandCopied',
          'Login command copied'
        )
      )
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button variant="ghost" size="xs" onClick={() => void handleCopy()}>
        <Copy className="size-3" />
        {translate(
          'auto.components.settings.SshTargetReadinessSection.copyLoginCommand',
          'Copy login command'
        )}
      </Button>
      {status === 'failed' ? (
        <p className="text-[11px] text-destructive">
          {translate(
            'auto.components.settings.SshTargetReadinessSection.copyLoginCommandFailed',
            'Could not copy the command.'
          )}
        </p>
      ) : null}
    </div>
  )
}

type SshTargetReadinessSectionProps = {
  /** Probe target; the section only ever renders for a connected host. */
  targetId: string
}

export function SshTargetReadinessSection({
  targetId
}: SshTargetReadinessSectionProps): React.JSX.Element {
  const [report, setReport] = useState<SshReadinessReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useMountedRef()

  const handleCheck = async (): Promise<void> => {
    if (checking) {
      return
    }
    setChecking(true)
    setError(null)
    try {
      const next = await window.api.ssh.probeReadiness({ targetId })
      if (mountedRef.current) {
        setReport(next)
      }
    } catch (err) {
      if (mountedRef.current) {
        // Why: a report from before the failure would read as the host's current state.
        setReport(null)
        setError(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.settings.SshTargetReadinessSection.checkFailed',
                'Could not check readiness.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setChecking(false)
      }
    }
  }

  const checks = report?.checks ?? []
  const hasLoginAction = checks.some((check) => loginCommandFor(check) !== null)
  // Why: the probe needs a POSIX shell; an all-unknown report means it could not run at all.
  const probeUnsupported = checks.length > 0 && checks.every((check) => check.state === 'unknown')

  return (
    <div className="basis-full space-y-2 border-t border-border/50 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('auto.components.settings.SshTargetReadinessSection.readiness', 'Readiness')}
        </h4>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1.5"
          disabled={checking}
          onClick={() => void handleCheck()}
        >
          {checking ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {translate('auto.components.settings.SshTargetReadinessSection.check', 'Check')}
        </Button>
      </div>

      {error ? <p className="text-xs text-destructive [overflow-wrap:anywhere]">{error}</p> : null}

      {probeUnsupported ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.SshTargetReadinessSection.probeUnsupported',
            'This host could not run the readiness check. It needs a POSIX shell, so Windows hosts are not checked yet.'
          )}
        </p>
      ) : null}

      {checks.length > 0 ? (
        <ul className="space-y-2">
          {checks.map((check) => {
            const loginCommand = loginCommandFor(check)
            return (
              <li key={check.key} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1 size-2 shrink-0 rounded-full',
                    readinessStatusColor(check.state)
                  )}
                />
                <span className="sr-only">{stateLabel(check.state)}</span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium">{checkLabel(check.key)}</span>
                    {loginCommand ? <CopyLoginCommandButton command={loginCommand} /> : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                    {check.detail}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}

      {hasLoginAction ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.SshTargetReadinessSection.loginHint',
            'Run it in a terminal on this host; the sign-in page opens here.'
          )}
        </p>
      ) : null}
    </div>
  )
}
