import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useWorktreeRuntimeTarget } from '@/runtime/use-worktree-runtime-target'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { TERMINAL_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY } from '../../../../shared/terminal-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { TerminalUsageLimitContinuationResult } from '../../../../shared/terminal-usage-limit-continuation'
import { usageLimitWords } from '../../../../shared/agent-session/failures/agent-session-usage-limit-words'
import { sayAgentSessionFailureTranslated } from '../native-chat/agent-session-failure-words-text'
import {
  attemptUsageLimitContinuation,
  usageLimitAttemptKey,
  useUsageLimitAttempt
} from './terminal-usage-limit-attempt'
import { TerminalUsageLimitOverlay } from './TerminalUsageLimitOverlay'
import {
  terminalUsageLimitNotice,
  type TerminalUsageLimitNotice
} from './terminal-usage-limit-notice'
import type { TerminalPaneController } from './use-terminal-pane-controller'

export function TerminalPaneUsageLimitPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const target = useWorktreeRuntimeTarget(controller.worktreeId)
  if (!target) {
    return null
  }
  return (
    <>
      {controller.managedPanes.map((pane) => {
        const ptyId = controller.paneTransportsRef.current.get(pane.id)?.getPtyId()
        if (!ptyId || controller.paneProcessExitsByPaneId[pane.id]) {
          return null
        }
        const visible =
          controller.isVisible &&
          !controller.showSshReconnectOverlay &&
          !(controller.effectiveChatViewMode && pane.leafId === controller.chatLeafId) &&
          !shouldShowMobileDriverOverlay(
            getDriverForPty(ptyId).kind,
            getFitOverrideForPty(ptyId)?.mode ?? null
          )
        return createPortal(
          <PaneUsageLimitNotice
            key={`${pane.leafId}:${ptyId}`}
            paneKey={makePaneKey(controller.tabId, pane.leafId)}
            target={target}
            visible={visible}
            worktreeId={controller.worktreeId}
          />,
          pane.container,
          `usage-limit-${pane.id}`
        )
      })}
    </>
  )
}

export function PaneUsageLimitNotice({
  paneKey,
  target,
  visible = true,
  worktreeId
}: {
  paneKey: string
  target: RuntimeClientTarget
  visible?: boolean
  worktreeId?: string
}): React.JSX.Element | null {
  const notice = useAppStore(
    useShallow((state) => terminalUsageLimitNotice(state.agentStatusByPaneKey[paneKey]))
  )
  if (!notice) {
    return null
  }
  return (
    <UsageLimitAction
      key={usageLimitAttemptKey(target, notice)}
      notice={notice}
      target={target}
      visible={visible}
      worktreeId={worktreeId}
    />
  )
}

function UsageLimitAction({
  notice,
  target,
  visible,
  worktreeId
}: {
  notice: TerminalUsageLimitNotice
  target: RuntimeClientTarget
  visible: boolean
  worktreeId?: string
}): React.JSX.Element | null {
  const capability = useStructuredAgentSessionHostCapabilityState(
    target,
    TERMINAL_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY
  )
  const { pending, result } = useUsageLimitAttempt(usageLimitAttemptKey(target, notice))
  const agent = structuredAgentLabel(notice.agent)
  const title = usageLimitWords(
    sayAgentSessionFailureTranslated,
    { agent },
    { window: notice.window },
    {}
  )
  const reset =
    notice.resetsAt === undefined
      ? translate('terminal.usageLimit.resetUnknown', 'Reset time unavailable.')
      : translate(
          'components.native-chat.failureWords.usageLimitResetsAt',
          'It resets at {{when}}.',
          {
            when: new Date(notice.resetsAt).toLocaleString(getIntlLocale(), {
              dateStyle: 'medium',
              timeStyle: 'short'
            })
          }
        )
  const outcome = result ? terminalUsageLimitActionWords(result, agent) : null
  const canRetry = !result || result.status === 'refused'
  const action =
    capability === 'unsupported'
      ? translate('terminal.usageLimit.legacy', 'Send a message in the terminal to continue.')
      : translate('terminal.usageLimit.explanation', 'Send “continue” to {{agent}} to try again.', {
          agent
        })
  const continueNow = async (): Promise<void> => {
    if (pending || capability !== 'supported') {
      return
    }
    await attemptUsageLimitContinuation(target, notice, worktreeId, () =>
      callRuntimeRpc<TerminalUsageLimitContinuationResult>(
        target,
        'terminal.continueAfterUsageLimit',
        {
          terminal: notice.terminal,
          sessionId: notice.sessionId,
          turnEndedAt: notice.turnEndedAt,
          client: { id: 'orca-desktop', type: 'desktop' }
        }
      )
    )
  }
  if (!visible) {
    return null
  }
  return (
    <TerminalUsageLimitOverlay
      title={title}
      body={`${reset}\n${outcome ?? action}`}
      pending={pending}
      actionDisabled={capability !== 'supported'}
      onContinue={canRetry && capability !== 'unsupported' ? () => void continueNow() : undefined}
    />
  )
}

export function terminalUsageLimitActionWords(
  result: TerminalUsageLimitContinuationResult,
  agent: string
): string {
  switch (result.status) {
    case 'turn-started':
    case 'input-accepted':
      return translate(
        'terminal.usageLimit.sent',
        'Continue was sent to {{agent}}. Check the terminal for its reply.',
        { agent }
      )
    case 'draft':
      return translate(
        'terminal.usageLimit.draft',
        'Continue is in {{agent}}’s draft. Review and send it in the terminal.',
        { agent }
      )
    case 'unknown':
      return translate(
        'terminal.usageLimit.unknown',
        'Couldn’t confirm whether {{agent}} received Continue. Check the terminal before trying again.',
        { agent }
      )
    case 'refused':
      if (result.reason === 'draft') {
        return translate(
          'terminal.usageLimit.existingDraft',
          '{{agent}} already has a draft. Send or clear it in the terminal, then try again.',
          { agent }
        )
      }
      if (result.reason === 'permission') {
        return translate(
          'terminal.usageLimit.permission',
          '{{agent}} is waiting for a choice. Resolve it in the terminal, then try again.',
          { agent }
        )
      }
      if (result.reason === 'changed') {
        return translate(
          'terminal.usageLimit.changed',
          'This {{agent}} turn changed. Check the terminal, then try again.',
          { agent }
        )
      }
      if (result.reason === 'in-progress') {
        return translate(
          'terminal.usageLimit.inProgress',
          'Continue is already being sent to {{agent}}. Check the terminal before trying again.',
          { agent }
        )
      }
      return translate(
        'terminal.usageLimit.unavailable',
        'Couldn’t continue {{agent}}. Check the terminal connection, then try again.',
        { agent }
      )
  }
}
