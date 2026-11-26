import { createElement, useCallback, useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  useAgentCliUpdate,
  type AgentCliUpdateView
} from '@/components/agent-cli-update/use-agent-cli-update'
import { isAgentCliUpdateAgent } from '../../../../../shared/agent-launch/installation/agent-cli-update'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatHostSetup } from './native-chat-host-setup'
import { AgentCliUpdateFailedChip } from '@/components/agent-cli-update/AgentCliUpdateFailedChip'
import type { NativeChatComposerNotice } from '../composer/controls/native-chat-composer-notice'

/** The chat's agent CLI update on its host; once current, `onUpdated` relists models and retries a refused start. */
export function useNativeChatCliUpdate(
  target: RuntimeClientTarget,
  agent: string,
  onUpdated: () => void
): AgentCliUpdateView | null {
  const {
    update,
    run,
    start: startUpdate,
    openFailure: openUpdateFailure
  } = useAgentCliUpdate(target, agent)
  const start = useCallback(
    () =>
      startUpdate().then((updated) => {
        if (updated) {
          onUpdated()
        }
        return updated
      }),
    [startUpdate, onUpdated]
  )
  const openFailure = useCallback(() => openUpdateFailure(start), [openUpdateFailure, start])
  const supported = isAgentCliUpdateAgent(agent)
  return useMemo(
    () => (supported ? { update, run, start, openFailure } : null),
    [supported, update, run, start, openFailure]
  )
}

/** Update for a CLI too old to chat, an inline action like Retry; once current, the chat retries. */
export function nativeChatCliUpdateAction(
  tooOld: boolean,
  setup: NativeChatHostSetup | null | undefined,
  t: Translate = translate
): NonNullable<NativeChatComposerNotice['action']> | undefined {
  const update = setup?.update
  if (!tooOld || !update) {
    return undefined
  }
  const running = update.run?.phase === 'running'
  const failed = update.run?.phase === 'failed'
  return {
    label: running
      ? t('agentCliUpdate.updating', 'Updating…')
      : failed
        ? t('agentCliUpdate.tryAgain', 'Try again')
        : t('agentCliUpdate.update', 'Update'),
    disabled: running,
    onClick: () => void update.start(),
    ...(failed
      ? { status: createElement(AgentCliUpdateFailedChip, { onOpen: update.openFailure }) }
      : {})
  }
}
