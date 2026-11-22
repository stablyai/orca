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
  | { phase: 'failed'; error: unknown }

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
    // A new turn retires the last answer: the confirmation has done its job, and Busy is stale.
    if (working) {
      setRestart(null)
    }
  }
  const program = agentPermissionSettingsSourceName(agent)
  if (restart?.phase === 'answered' && restart.outcome !== 'busy') {
    return {
      key: 'provider-update',
      kind: 'update',
      text: t(
        'components.native-chat.providerUpdate.restarted',
        'Restarted. Your next message runs {{program}} {{installed}} and continues this conversation.',
        { program, installed: restart.installedVersion }
      ),
      onDismiss: () => setRestart(null)
    }
  }
  if (!update || dismissed === update.installedVersion) {
    return null
  }
  const run = (): void => {
    const { installedVersion } = update
    setRestart({ phase: 'restarting' })
    callStructuredAgentSession<{ outcome: RestartAgentOutcome }>(
      target,
      'agentSession.restartAgent',
      { sessionId }
    ).then(
      ({ outcome }) =>
        mountedRef.current && setRestart({ phase: 'answered', outcome, installedVersion }),
      (error: unknown) => mountedRef.current && setRestart({ phase: 'failed', error })
    )
  }
  const available = t(
    'components.native-chat.providerUpdate.available',
    '{{program}} {{installed}} is installed. This chat is still running {{running}}.',
    { program, installed: update.installedVersion, running: update.runningVersion }
  )
  const content =
    restart?.phase === 'failed'
      ? nativeChatNoticeFromError(
          restart.error,
          t('components.native-chat.providerUpdate.failed', 'Couldn’t restart this chat.')
        )
      : restart?.phase === 'answered'
        ? {
            text: t(
              'components.native-chat.providerUpdate.busy',
              '{{agent}} is still working. Restart when this turn ends.',
              { agent: agentLabel }
            )
          }
        : { text: available }
  return {
    key: 'provider-update',
    kind: 'update',
    ...content,
    action: {
      label: t('components.native-chat.providerUpdate.restart', 'Restart chat'),
      onClick: run,
      disabled: working || restart?.phase === 'restarting'
    },
    onDismiss: () => setDismissed(update.installedVersion)
  }
}
