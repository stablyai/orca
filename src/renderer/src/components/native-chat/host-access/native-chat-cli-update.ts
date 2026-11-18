import { useCallback, useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  useAgentCliUpdate,
  type AgentCliUpdateView
} from '@/components/agent-cli-update/use-agent-cli-update'
import { isAgentCliUpdateAgent } from '../../../../../shared/agent-launch/installation/agent-cli-update'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatHostSetup } from './native-chat-host-setup'

/** The chat's agent CLI update on its host; once current, `onUpdated` relists models and retries a refused start. */
export function useNativeChatCliUpdate(
  target: RuntimeClientTarget,
  agent: string,
  onUpdated: () => void
): AgentCliUpdateView | null {
  const { update, run, start: startUpdate } = useAgentCliUpdate(target, agent)
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
  const supported = isAgentCliUpdateAgent(agent)
  return useMemo(() => (supported ? { update, run, start } : null), [supported, update, run, start])
}

/** Update for a CLI too old to chat; the setup's update retries the chat once current. */
export function nativeChatCliUpdateAction(
  tooOld: boolean,
  setup: NativeChatHostSetup | null | undefined,
  t: Translate = translate
): { label: string; primary: true; disabled: boolean; onClick: () => void } | undefined {
  const update = setup?.update
  if (!tooOld || !update) {
    return undefined
  }
  const running = update.run?.phase === 'running'
  return {
    label: running
      ? t('agentCliUpdate.updating', 'Updating…')
      : update.run?.phase === 'failed'
        ? t('agentCliUpdate.tryAgain', 'Try again')
        : t('agentCliUpdate.update', 'Update'),
    primary: true,
    disabled: running,
    onClick: () => void update.start()
  }
}
