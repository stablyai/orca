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
/** Paired windows and phones read a chat's worker approvals and answer them as the person. */
export const ORCHESTRATION_PAIRED_WORKER_APPROVALS_RUNTIME_CAPABILITY =
  'orchestration.paired-worker-approvals.v1' as const
/** A person on a paired window may Clear and Stop a chat's workers in its dock, as on this computer. */
export const ORCHESTRATION_PAIRED_WORKER_DOCK_OWNER_RUNTIME_CAPABILITY =
  'orchestration.paired-worker-dock-owner.v1' as const
/** Sent by a paired window or phone, never by the orca CLI: its approvals are the person's. */
export const ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY =
  'orchestration.person-approvals.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION = 2 as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION = 3 as const
export const ORCHESTRATION_CONTRACT_VERSION = 1 as const
/** Contract 1 admitted only as a replay or join of an existing receipt, for a worker_done retry after
 *  a timeout that may have been delivered. Reserved: a future contract must not reuse this number. */
export const ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION = 2 as const
/** This runtime enforces the replay-only contract. Releases without the contract fence ignore the
 *  version and would run the retry anew, so a client sends one only to a runtime that advertises this. */
export const ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY =
  'orchestration.replay-only-retry.v1' as const
export const ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY = 'orchestration.contract.v1' as const
/** Receives agent mail a paired Orca carries for its agents, and queues replies for it to pull. */
export const ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY = 'orchestration.peer-mail.v1' as const
/** Peer mail also carries ordinary questions, dispatch instructions and merge-ready messages. */
export const ORCHESTRATION_PEER_MAIL_TYPES_RUNTIME_CAPABILITY =
  'orchestration.peer-mail-types.v1' as const
/** Peer mail also reaches its bots (`bot:`, `--chat`, questions), admitted as its own bot mail is. */
export const ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY =
  'orchestration.peer-bot-mail.v1' as const
/** Peer mail about a bot's item also carries files uploaded here for that item's chat. */
export const ORCHESTRATION_PEER_MAIL_FILES_RUNTIME_CAPABILITY =
  'orchestration.peer-mail-files.v1' as const
/** Runs the workers a paired Orca places here as its own, coordinated from that Orca (wire v1). */
export const ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY =
  'orchestration.remote-owned-workers.v1' as const
/** A paired Orca's chat-lineage start (`chatLineage`) starts here as a chat, and so do the workers it starts. */
export const ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY =
  'orchestration.chat-lineage.v1' as const
/** Its agents can message agents on a paired computer that pulls with `clientAsks`
 *  (`send --on-client`); replies come back by `peerMailReturn`. */
export const ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY =
  'orchestration.client-agent-asks.v1' as const
/** `orchestration.taskUpdate` accepts worker-only passive `--note` updates on `dispatch_contexts`. */
export const ORCHESTRATION_TASK_UPDATE_NOTE_RUNTIME_CAPABILITY =
  'orchestration.task-update-note.v1' as const

export const ORCHESTRATION_RUNTIME_CAPABILITIES = [
  ORCHESTRATION_TASK_UPDATE_NOTE_RUNTIME_CAPABILITY,
  ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY,
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
  ORCHESTRATION_PAIRED_WORKER_APPROVALS_RUNTIME_CAPABILITY,
  ORCHESTRATION_PAIRED_WORKER_DOCK_OWNER_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_TYPES_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_FILES_RUNTIME_CAPABILITY,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY
] as const
