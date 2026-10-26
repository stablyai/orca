import { ingestPreparedJcodeHooks } from '../shared/agent-hook-listener/jcode-hook-ingress'
import type { JcodeSessionInput } from '../shared/agent-hook-listener/jcode-session-registry'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import { RelayProviderHookNormalization } from './agent-hook-provider-normalization'

export function ingestRelayJcodeHook(
  state: HookListenerState,
  env: string,
  input: JcodeSessionInput,
  host: {
    providerNormalization?: RelayProviderHookNormalization
    isCurrent?: () => boolean
    isCanonicalPane?: (paneKey: string) => boolean
    isPaneSurfaceRetired: (paneKey: string) => boolean
    getAgentLaunchToken: (paneKey: string) => string | undefined
    apply: (
      event: AgentHookEventPayload,
      source: AgentHookSource,
      env?: string,
      version?: string,
      options?: { isReplay?: boolean; onCommitted?: () => void }
    ) => AgentHookEventPayload | undefined | void
  }
): void {
  const normalization = host.providerNormalization ?? new RelayProviderHookNormalization()
  ingestPreparedJcodeHooks(
    state,
    input,
    (next) => normalization.prepareJcode(state, next.body, env, next),
    (prepared, next) => {
      const paneKey = prepared.admission.paneKey
      const token = host.getAgentLaunchToken(paneKey)
      if (
        (host.isCurrent && !host.isCurrent()) ||
        host.isCanonicalPane?.(paneKey) ||
        host.isPaneSurfaceRetired(paneKey) ||
        (token && token !== prepared.admission.launchToken?.trim())
      ) {
        return
      }
      if (!prepared.event) {
        prepared.commit()
        return
      }
      host.apply(prepared.event, 'jcode', hookBodyEnv(next.body), hookBodyVersion(next.body), {
        isReplay: next.isReplay,
        onCommitted: prepared.commit
      })
    }
  )
}
