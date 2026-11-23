import { useState } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { agentPermissionSettingsSourceName } from '../../../../../../shared/agent-launch/permissions/agent-permission-settings-source'
import type { RestartAgentOutcome } from '../../../../../../shared/rpc-contract/structured-agent-session/restart-agent-params'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useTranslate } from '../../../../i18n/use-translate'
import { useNativeChatPaneMountedRef } from '../../pane/ownership/native-chat-pane-lifetime'
import { useStructuredAgentSessionProviderUpdate } from '../../session/status/structured-agent-session-status-hooks'
import {
  nativeChatNoticeFromError,
  type NativeChatComposerNotice
} from '../../composer/controls/native-chat-composer-notice'

type Restart =
  | { phase: 'restarting' }
  | { phase: 'answered'; outcome: RestartAgentOutcome; installedVersion: string }
  | { phase: 'failed'; error: unknown; installedVersion: string }

/** Says when the host has a newer agent installed than this chat runs, and restarts it on request. */
export function useNativeChatProviderUpdateNotice({
  sessionId,
  target,
  agent,
  agentLabel,
  working
}: {
  sessionId: string
  target: RuntimeClientTarget
  agent: string
  agentLabel: string
  working: boolean
}): NativeChatComposerNotice | null {
  const t = useTranslate()
  const update = useStructuredAgentSessionProviderUpdate(sessionId, target)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [restart, setRestart] = useState<Restart | null>(null)
  const mountedRef = useNativeChatPaneMountedRef()
  const [wasWorking, setWasWorking] = useState(working)
  if (working !== wasWorking) {
    setWasWorking(working)
    // A turn starting or ending outdates the last answer, and one still on its way.
    setRestart(null)
  }
  const program = agentPermissionSettingsSourceName(agent)
  // A press with no answer (a timeout, say) still settled if the host has since dropped the update,
  // which it does once that agent stops.
  if (
    (restart?.phase === 'answered' && restart.outcome !== 'busy') ||
    (restart?.phase === 'failed' && !update)
  ) {
    const installed = { program, installed: restart.installedVersion }
    return {
      key: 'provider-update',
      kind: 'update',
      text:
        restart.phase === 'answered' && restart.outcome === 'stopped'
          ? t(
              'components.native-chat.providerUpdate.restarted',
              'Restarted. Your next message runs {{program}} {{installed}} and continues this conversation.',
              installed
            )
          : t(
              'components.native-chat.providerUpdate.notRunning',
              'Your next message starts {{program}} {{installed}} and continues this conversation.',
              installed
            ),
      onDismiss: () => setRestart(null)
    }
  }
  if (!update || dismissed === update.installedVersion) {
    return null
  }
  const run = (): void => {
    const { installedVersion } = update
    const pressed: Restart = { phase: 'restarting' }
    setRestart(pressed)
    // Only the press still on screen takes the answer; a retired or newer one drops it.
    const settle = (next: Restart) =>
      mountedRef.current && setRestart((current) => (current === pressed ? next : current))
    callStructuredAgentSession<{ outcome: RestartAgentOutcome }>(
      target,
      'agentSession.restartAgent',
      { sessionId }
    ).then(
      ({ outcome }) => settle({ phase: 'answered', outcome, installedVersion }),
      (error: unknown) => settle({ phase: 'failed', error, installedVersion })
    )
  }
  const versions = {
    program,
    installed: update.installedVersion,
    running: update.runningVersion
  }
  const content =
    restart?.phase === 'failed'
      ? nativeChatNoticeFromError(
          restart.error,
          t(
            'components.native-chat.providerUpdate.failed',
            'Couldn’t confirm that this chat restarted.'
          )
        )
      : restart?.phase === 'answered'
        ? {
            text: t(
              'components.native-chat.providerUpdate.busy',
              '{{agent}} still has work open in this chat, so it kept running. Try again when it finishes.',
              { agent: agentLabel }
            )
          }
        : {
            text: working
              ? t(
                  'components.native-chat.providerUpdate.availableWhileWorking',
                  '{{program}} {{installed}} is installed. This chat is still running {{running}} and can restart when this turn ends.',
                  versions
                )
              : t(
                  'components.native-chat.providerUpdate.available',
                  '{{program}} {{installed}} is installed. This chat is still running {{running}}.',
                  versions
                )
          }
  return {
    key: 'provider-update',
    kind: restart?.phase === 'failed' ? 'error' : 'update',
    ...content,
    action: {
      label: t('components.native-chat.providerUpdate.restart', 'Restart chat'),
      onClick: run,
      disabled: working,
      pending: restart?.phase === 'restarting'
    },
    onDismiss: () => setDismissed(update.installedVersion)
  }
}
