import {
  relayHookRootAcquisition,
  type RelayHookAdmissionOptions
} from './agent-hook-event-admission'
import { admitRelayOpenCodeTui } from './agent-hook-request'
import { checkHookOwnerPresence } from '../shared/agent-hook-owner-presence'
import type { HookRootEvidenceReader } from '../shared/hook-process-root-evidence'
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
import { hookRootAnswerDeadline } from '../shared/hook-root-attempts'
import type { RelayProviderHookNormalization } from './agent-hook-provider-normalization'

type RelayHookSpoolHost = {
  isCurrent?: () => boolean
  providerNormalization?: RelayProviderHookNormalization
  checkAgentPresence?: (paneKey: string) => Promise<void>
  readHookRootEvidence?: HookRootEvidenceReader
  /** The drain's one answer deadline, shared by all its records. */
  answerBy?: number
  apply: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    admission?: RelayHookAdmissionOptions
  ) => void
  onAccepted?: (event: AgentHookEventPayload) => void
  isPaneSurfaceRetired: (paneKey: string) => boolean
  getAgentLaunchToken: (paneKey: string) => string | undefined
}

export function ingestRelayHookSpoolRecord(
  record: SpoolRecord,
  state: HookListenerState,
  env: string,
  host: RelayHookSpoolHost
): Promise<void> | void {
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  const source = record.source
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
      host.apply(event, record.source, hookBodyEnv(body), hookBodyVersion(body), {
        isReplay: true,
        onAccepted: host.onAccepted
      })
    }
  }
  const pending = host.checkAgentPresence
    ? checkHookOwnerPresence(
        state,
        record.source,
        body,
        env,
        host.checkAgentPresence,
        relayHookRootAcquisition(
          host.readHookRootEvidence,
          state,
          (event) =>
            host.apply(event, source, hookBodyEnv(body), hookBodyVersion(body), {
              checkPresence: false
            }),
          host.answerBy
        )
      )
    : undefined
  return pending ? pending.then(apply) : apply()
}

/** Replay the relay's spool in order; `hostOf` binds each record's host. */
export async function drainRelayHookSpool(
  endpointDir: string,
  state: HookListenerState,
  env: string,
  hostOf: (record: SpoolRecord) => RelayHookSpoolHost
): Promise<void> {
  // Why: records replay in order before the listener binds; one answer allowance covers them all.
  const answerBy = hookRootAnswerDeadline()
  try {
    await drainAgentHookSpoolAsync({
      endpointDir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (record) =>
        ingestRelayHookSpoolRecord(record, state, env, { ...hostOf(record), answerBy })
    })
  } catch (err) {
    // Keep the listener starting on downstream failure; the intact spool can retry next restart.
    process.stderr.write(
      `[relay-hook-server] spool replay failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
}
