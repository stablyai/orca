import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { CodexComputerUseRuntimeStatus } from '../../../../shared/codex-computer-use-runtime'
import {
  collectAgentSessionRestartPlanFromState,
  getAgentSessionRestartController
} from '@/lib/agent-session-restart-service'
import { agentSessionRestartSkipMessage } from '@/lib/agent-session-restart-plan'
import type { AgentSessionRestartTarget } from '@/lib/agent-session-restart-plan'
import { formatAgentSessionRestartOutcome } from '@/lib/agent-session-restart-run'
import { AgentSessionRestartCommandDialog } from '../settings/AgentSessionRestartCommandDialog'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

const dismissedPtyIds = new Set<string>()

export function CodexComputerUseRuntimeBanner({
  ptyId,
  tabId,
  leafId,
  isVisible
}: {
  ptyId: string
  tabId: string
  leafId: string
  isVisible: boolean
}): React.JSX.Element | null {
  const paneKey = makePaneKey(tabId, leafId)
  const codexInPane = useAppStore(
    (state) =>
      state.agentStatusByPaneKey[paneKey]?.agentType === 'codex' ||
      state.paneForegroundAgentByPaneKey[paneKey]?.agent === 'codex'
  )
  const [status, setStatus] = useState<CodexComputerUseRuntimeStatus | null>(null)
  const [dismissed, setDismissed] = useState(() => dismissedPtyIds.has(ptyId))
  const [commandTarget, setCommandTarget] = useState<AgentSessionRestartTarget | null>(null)
  const controller = getAgentSessionRestartController()
  const report = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const agentStatus = useAppStore((state) => state.agentStatusByPaneKey[paneKey])
  const launchConfigs = useAppStore((state) => state.agentLaunchConfigByPaneKey[paneKey])
  void agentStatus
  void launchConfigs
  const target =
    isVisible && codexInPane && status?.status === 'stale'
      ? collectAgentSessionRestartPlanFromState(useAppStore.getState()).targets.find(
          (entry) => entry.pane.ptyId === ptyId && entry.pane.agent === 'codex'
        )
      : undefined
  const outcome = report.outcomes.find((entry) => entry.ptyId === ptyId)

  useEffect(() => {
    const inspect = window.api.pty.inspectCodexComputerUseRuntime
    if (!isVisible || !codexInPane || dismissed || !inspect) {
      return
    }
    let cancelled = false
    let checking = false
    const check = (): void => {
      if (checking) {
        return
      }
      checking = true
      void inspect(ptyId)
        .then(
          (next) => {
            if (!cancelled) {
              setStatus(next)
            }
          },
          () => {}
        )
        .finally(() => {
          checking = false
        })
    }
    check()
    const timer = setInterval(check, 60_000)
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [ptyId, isVisible, codexInPane, dismissed])

  const showBanner =
    isVisible && codexInPane && !dismissed && status?.status === 'stale' && target !== undefined
  if (!showBanner && !commandTarget) {
    return null
  }
  const explicitCommand =
    target?.kind === 'skipped' &&
    ['unknown-launch', 'missing-session', 'resume-unavailable'].includes(target.reason)
  const unavailable = target?.kind === 'skipped' && !explicitCommand
  const pending = outcome?.status === 'queued' || outcome?.status === 'pending'
  return (
    <>
      {showBanner && target ? (
        <CodexComputerUseRuntimeNotice
          explicitCommand={explicitCommand}
          disabled={report.running || pending || unavailable}
          message={
            outcome
              ? formatAgentSessionRestartOutcome(outcome)
              : unavailable && target.kind === 'skipped'
                ? agentSessionRestartSkipMessage(target.reason)
                : undefined
          }
          onRestart={() => {
            if (explicitCommand) {
              setCommandTarget(target)
              return
            }
            void controller
              .request('codex', [ptyId])
              .catch((error: unknown) => console.warn('[codex-cua-runtime] restart failed:', error))
          }}
          onDismiss={() => {
            dismissedPtyIds.add(ptyId)
            setDismissed(true)
          }}
        />
      ) : null}
      {commandTarget ? (
        <AgentSessionRestartCommandDialog
          target={commandTarget}
          onClose={() => setCommandTarget(null)}
        />
      ) : null}
    </>
  )
}

export function CodexComputerUseRuntimeNotice({
  explicitCommand,
  disabled,
  message,
  onRestart,
  onDismiss
}: {
  explicitCommand: boolean
  disabled: boolean
  message?: string
  onRestart: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <PaneTopWarningBanner
      title={translate(
        'terminal.codexCuaRuntime.title',
        'Computer Use is still using an older app runtime'
      )}
      body={
        <>
          {explicitCommand
            ? translate(
                'terminal.codexCuaRuntime.explicitBody',
                'Restart this Codex to load the current Computer Use runtime. Supply an explicit resume command to keep your conversation.'
              )
            : translate(
                'terminal.codexCuaRuntime.body',
                'Restart this Codex to load the current Computer Use runtime. Your conversation is kept; active work waits until idle.'
              )}
          {message ? <> {message}</> : null}
        </>
      }
      primaryAction={
        <Button variant="outline" size="xs" disabled={disabled} onClick={onRestart}>
          {explicitCommand
            ? translate('terminal.codexCuaRuntime.command', 'Restart with command…')
            : translate('terminal.codexCuaRuntime.restart', 'Restart this Codex')}
        </Button>
      }
      onDismiss={onDismiss}
    />
  )
}
