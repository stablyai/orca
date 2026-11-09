export const ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY = 'orchestration.federation.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY =
  'orchestration.federation-control-mail.v1' as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY =
  'orchestration.federation-lifecycle-settlement.v1' as const
export const ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY =
  'orchestration.worker-stop-verdict.v1' as const
/** worker-stop on this host also stops the helpers the worker started here. */
export const ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY =
  'orchestration.worker-stop-helpers.v1' as const
export const ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY =
  'orchestration.worker-launch-preferences.v1' as const
export const ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY =
  'orchestration.federation-structured-read.v1' as const
export const ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY =
  'orchestration.federation-fleet-snapshot.v1' as const
export const ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY =
  'orchestration.federation-release-archive.v1' as const
/** Settled workers release after a grace period; retain and reuse forward to the execution host. */
export const ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY =
  'orchestration.worker-auto-release.v1' as const
/** Finished workers close when a host countdown runs out; clients show it and offer Keep open (workerAutoClose, workerKeepOpen). */
export const ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY =
  'orchestration.worker-keep-open.v1' as const
/** worker-start creates and binds a Run when its coordinator has none. */
export const ORCHESTRATION_WORKER_START_IMPLICIT_RUN_RUNTIME_CAPABILITY =
  'orchestration.worker-start-implicit-run.v1' as const
/** A coordinator stays bound to every Run it created or used, not only the latest. */
export const ORCHESTRATION_RETAINED_RUN_BINDINGS_RUNTIME_CAPABILITY =
  'orchestration.retained-run-bindings.v1' as const
/** The host reports a worker whose turn ends without worker_done or that sits at a prompt. */
export const ORCHESTRATION_WORKER_TURN_STOP_REPORTS_RUNTIME_CAPABILITY =
  'orchestration.worker-turn-stop-reports.v1' as const
/** ask can record a question and return at once; its answer arrives as Dispatch mail. */
export const ORCHESTRATION_ASK_RETURNS_AT_ONCE_RUNTIME_CAPABILITY =
  'orchestration.ask-returns-at-once.v1' as const
/** A finished remote worker takes follow-ups here and can still mail and ask its Run home. */
export const ORCHESTRATION_FEDERATION_FOLLOW_UP_RUNTIME_CAPABILITY =
  'orchestration.federation-follow-up.v1' as const
/** This server starts a remote worker as a chat when its own settings prefer chats and the home asks for it. */
export const ORCHESTRATION_FEDERATION_CHAT_WORKERS_RUNTIME_CAPABILITY =
  'orchestration.federation-chat-workers.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION = 2 as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION = 3 as const
export const ORCHESTRATION_FEDERATION_FOLLOW_UP_PROTOCOL_VERSION = 4 as const
/** The home understands a chat worker in the receipt; an older home always gets a terminal. */
export const ORCHESTRATION_FEDERATION_CHAT_WORKERS_PROTOCOL_VERSION = 5 as const
export const ORCHESTRATION_CONTRACT_VERSION = 1 as const
export const ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY = 'orchestration.contract.v1' as const

export const ORCHESTRATION_RUNTIME_CAPABILITIES = [
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_START_IMPLICIT_RUN_RUNTIME_CAPABILITY,
  ORCHESTRATION_RETAINED_RUN_BINDINGS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_TURN_STOP_REPORTS_RUNTIME_CAPABILITY,
  ORCHESTRATION_ASK_RETURNS_AT_ONCE_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_FOLLOW_UP_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CHAT_WORKERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
] as const

/** The newest federated protocol both sides speak; each version needs every earlier one's capability. */
export function federationProtocolVersionFor(
  capabilities: readonly string[] | undefined
): 1 | 2 | 3 | 4 | 5 {
  const ladder = [
    [
      ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
    ],
    [
      ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
    ],
    [
      ORCHESTRATION_FEDERATION_FOLLOW_UP_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_FOLLOW_UP_PROTOCOL_VERSION
    ],
    [
      ORCHESTRATION_FEDERATION_CHAT_WORKERS_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_CHAT_WORKERS_PROTOCOL_VERSION
    ]
  ] as const
  let version: 1 | 2 | 3 | 4 | 5 = 1
  for (const [capability, next] of ladder) {
    if (!capabilities?.includes(capability)) {
      break
    }
    version = next
  }
  return version
}
