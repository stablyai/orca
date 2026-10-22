import { admitRelayOpenCodeTui } from './agent-hook-request'
import { checkHookOwnerPresence } from '../shared/agent-hook-owner-presence'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { isAgentHookSource, type AgentHookSource } from '../shared/agent-hook-relay'
import {
  buildSpoolHookBody,
  drainAgentHookSpoolAsync,
  type SpoolRecord
} from '../shared/agent-hook-spool'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import type { RelayProviderHookNormalization } from './agent-hook-provider-normalization'

export function ingestRelayHookSpoolRecord(
  record: SpoolRecord,
  state: HookListenerState,
  env: string,
  host: {
    isCurrent?: () => boolean
    providerNormalization?: RelayProviderHookNormalization
    checkAgentPresence?: (paneKey: string) => Promise<void>
    apply: (
      event: AgentHookEventPayload,
      source: AgentHookSource,
      env?: string,
      version?: string
    ) => void
    isPaneSurfaceRetired: (paneKey: string) => boolean
    getAgentLaunchToken: (paneKey: string) => string | undefined
  }
): Promise<void> | void {
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  const apply = () => {
    if (host.isCurrent && !host.isCurrent()) {
      throw new Error('Relay hook spool replay interrupted')
    }
    if (!isAgentHookSource(record.source)) {
      return
    }
    const options: Parameters<typeof normalizeHookPayload>[4] = {
      admitOpenCodeTui: (identity) => admitRelayOpenCodeTui(host, identity),
      deferCompactOwnershipToClient: true
    }
    const event = host.providerNormalization
      ? host.providerNormalization.normalize(state, record.source, body, env, options)
      : normalizeHookPayload(state, record.source, body, env, options)
    if (event) {
      host.apply(event, record.source, hookBodyEnv(body), hookBodyVersion(body))
    }
  }
  const pending = host.checkAgentPresence
    ? checkHookOwnerPresence(state, record.source, body, env, host.checkAgentPresence)
    : undefined
  return pending ? pending.then(apply) : apply()
}

export async function drainRelayHookSpool(
  endpointDir: string,
  ingest: (record: SpoolRecord) => Promise<void> | void
): Promise<void> {
  try {
    await drainAgentHookSpoolAsync({
      endpointDir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest
    })
  } catch (err) {
    // Why: a downstream relay failure must not prevent the loopback listener from starting;
    // the untruncated spool file remains available for retry on the next restart.
    process.stderr.write(
      `[relay-hook-server] spool replay failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
}
