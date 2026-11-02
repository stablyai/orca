export const PROJECT_HOST_SETUP_RUNTIME_CAPABILITY = 'project-host-setup.v1' as const
export const TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY = 'task-source-context.v1' as const
export const WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY = 'workspace-run-context.v1' as const
export const WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY = 'worktree.provisioned-root.v1' as const
export const WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY =
  'worktree.linked-work-item-context.v1' as const
export const WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY =
  'worktree.github-pr-suppression.v1' as const
// Legacy clients cannot safely derive a branch name from a qualified ref selector.
export const REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY =
  'repo.search-qualified-refs.v1' as const
export const REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY = 'remote-runtime.shared-control.v1' as const
export const FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY =
  'folder-workspace.path-status.v1' as const
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY =
  'linear.issue-attribute-filter.v1' as const
// Why: signals the host exposes the Agent Session History scanner over RPC
// (aiVault.listSessions). Registered unconditionally for every build, so it is a
// STATIC capability advertised by getStatus() automatically — NOT a runtime
// conditional like browser.headless.v1.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const
// Why: signals a host owns browser pages with no renderer (headless serve via the
// offscreen backend). Advertised only when that backend is actually available, so
// clients never fall back to a local desktop browser tab for a remote-owned page.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_IDENTITY_RUNTIME_CAPABILITY = 'browser.identity.v1' as const
// Why conditional: only a desktop runtime holds the SSH registry managed servers are run from.
export const MANAGED_SERVER_RUNTIME_CAPABILITY = 'managedServer.v1' as const
export const BROWSER_SCREENCAST_RUNTIME_CAPABILITY = 'browser.screencast.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
// Why: older hosts discard browser.tabCreate's page field, so clients may only
// treat a preallocated page ID as canonical when this is advertised.
export const BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY =
  'browser.tab-create-known-id.v1' as const
export const BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY = 'browser.clientHost.v1' as const
export const BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY =
  'browser.clientHost.pageMetadata.v1' as const
export const BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY =
  'browser.clientHost.automation.v1' as const
// Why: without it a client-placed browser.upload would resolve remote paths on the desktop filesystem, so uploads fail closed instead.
export const BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY =
  'browser.clientHost.fileChannel.v1' as const
export const BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY = 'network.browserTunnel.v1' as const
export const BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY =
  'network.browserTunnel.executionHosts.v1' as const
// Why: hosts without this strip terminal.send's inputKind (zod object drops
// unknown keys), so a mobile xterm query reply would land as ordinary
// floor-taking input. Mobile must not forward replies unless advertised.
export const TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY =
  'terminal.query-reply-input.v1' as const
// Why: without this, prompt request IDs and waitSubmitMs are stripped and a retry would resend raw input.
export const TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY = 'terminal.prompt-delivery.v1' as const
// Why: paired clients may unmount xterm only when the host can return a
// bounded, sequenced scrollback snapshot for lossless reveal.
export const TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY = 'terminal.paired-parking.v1' as const
// Why: terminal.ensureAgentSession params are strict, so an older host rejects `spawnIntent`; a
// host that advertises this also may answer a declared restore with `terminal_spawn_deferred`.
export const TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY = 'terminal.spawn-intent.v1' as const
// Why: clients offer "Resume automatic restores" only on hosts that can clear a recorded pause.
export const RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY = 'runtime.automatic-work.v1' as const
// Why: older hosts lack the targeted settings RPCs and strip agentPrompt from
// terminal creation, so mobile must hide Quick Commands unless both are present.
export const TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY = 'terminal.quick-commands.v1' as const
// Why: older hosts strip worktree.create's clientMutationId, so mobile must only
// replay ambiguous cutovers when the host advertises idempotent create support;
// status.worktreeCreateIdempotency carries the optional host retention policy.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
// Scope of the claim: a hook that RUNS and fails cannot delete the checkout. It does not promise
// the hook was found — an SSH host whose orca.yaml cannot be read answers "no hook" and the removal
// proceeds, because a failed read is indistinguishable from an absent file across the relay
// (#20196 tracks the provider contract that would separate them).
// Why (#19334): "accepts --run-hooks" and "refuses to delete when the archive hook fails" were
// indistinguishable from the outside — both take the flag and behave identically on success, so
// the only way to tell an unfixed host apart was to fail a hook and see whether the checkout
// survived. Lifecycle integrations keep teardown evidence inside the checkout and cannot risk
// that. Advertised unconditionally: every build carrying this constant has the gate.
export const WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY =
  'worktree.archive-failure-blocking.v1' as const
// Why: older hosts cannot reconcile terminal.create's mutation after losing the reply, so clients may only retry unknown outcomes when advertised.
export const TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'terminal.create-idempotency.v2' as const
// Why: an older host strips terminal.create's unknown `shell` and answers with a terminal running
// the host default shell. That reply is indistinguishable from success, so a client asking for a
// shell must refuse rather than create the wrong one.
export const TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY =
  'terminal.create-shell-selection.v1' as const
export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const
export const SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY =
  'session-tabs.authoritative-inventory.v1' as const
// Why: a client advertising this retains every terminal retirement proof it receives until the
// surface is published live again, so a session-tabs stream sends each proof once instead of
// repeating the host's whole bounded list on every title tick.
export const SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY =
  'session-tabs.retirement-proof-delta.v1' as const
// Why: a client advertising this rebuilds each `updated` frame's tab list from the previous frame
// on the same stream, so one tab's status change no longer re-sends every tab in the worktree.
export const SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY = 'session-tabs.tab-delta.v1' as const
// Why: a client advertising this reads `restoredUnconfirmed` agent rows as unverifiable; older
// clients would read their last known state as live, so they keep the legacy `done` projection.
export const AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY =
  'agent-status.restored-unconfirmed.v1' as const
export const AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY =
  'agent-session.session-boundary.v1' as const
export const AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY =
  'agent-session.host-authority.v1' as const
// Older launch schemas reject unknown fields; advertise before clients send keyboard support.
export const AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY = 'agent-session.keyboard.v1' as const
export const AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY =
  'agent-session.omp-resume-path.v1' as const
// Why: structured sessions are journal-backed, not PTY-backed, so an incapable client must not
// receive their journal or drive their lifecycle. Mobile may receive a metadata-only placeholder;
// the host still refuses agentSession.* methods and destructive tab mutations without capability.
export const STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY = 'agent-session.structured.v1' as const
// Why: hosts before this gated `agentSession.*` on their own chat setting while still advertising
// agent-session.structured.v1, so that capability alone cannot tell a client its chat will be
// admitted. A host advertising this admits by client capability alone; a client advertising it
// picks each launch's mode itself. A client without it asks `agentSession.createSupport` to pick
// for it (released phones), so the host keeps answering that with its own setting.
export const STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY =
  'agent-session.structured.client-launch-mode.v1' as const
// Why: older structured clients render durable pending replies as uncertain delivery. Capable
// clients skip the host's bounded best-effort settlement observation.
export const AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY =
  'agent-session.pending-send-result.v1' as const
// Why: a send is now answered once the host accepts it, before any agent has it. A client without
// this cannot show a message rejected after that answer, so the host holds its reply until the
// message is handed over or rejected. Transitional: drop the hold once no supported desktop or
// mobile client lacks the capability; mobile must first show a rejected message in place.
export const AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY =
  'agent-session.accepted-send.v1' as const
// Why: a host advertising this answers a resent send id from its record before anything else may
// refuse it, so a refusal `agentSession.send` RETURNS is proof; a thrown error never is, a thrown
// refusal included (host not installed, journal database won't open, host disabled). Reading a
// returned `ok: false`: `agent_session_operation_unknown` with `outcomeUnknown` or `resultLost` —
// the host cannot tell yet, resend the same id; with `rewindUnconfirmed` — settled, nothing was
// written. `agent_session_operation_expired` — only the transcript can tell. An
// `agent_session_operation_conflict` or `messageIdReused` — the id holds a different payload,
// which proves nothing about this message; nor does `sessionNotAttached` (the chat's record is
// gone or unreadable on this host). Any other — the chat holds no message under that id and none
// is in flight, but a resend of that id may still run as a new send, so a client that hands the
// text back must not resend the old id. An older host may refuse an id it recorded: none of this
// holds there.
export const AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY =
  'agent-session.send-answers-proof.v1' as const
// Why: `agentSession.send`'s params are strict, so an older host rejects `delivery`; and only a
// capable client can render the `queued` result arm. It gates `delivery: 'queue-if-active'` and
// the client's queueing setting and chord, never the published draft list or its card actions: a
// host without it still publishes a message it kept unsent across a restart or a close, and both
// clients show that card and call its actions. DARK ON PURPOSE — not in RUNTIME_CAPABILITIES:
// advertising still requires the integrated Codex steer matrix (#21062) in the shipped host.
// v1 includes `submission.queuedMessageId` on every draft hand-off: a client reads that link and
// never compares a draft id with a submission id. It also publishes the queue's pause once, as
// `queuePause` beside the list, lifted by `agentSession.queuedMessagesResume` or any turn sent
// after it starting; while it is set every waiting card waits. `nextQueuedMessageId` beside the list
// names the card the queue sends next once nothing runs, null while anything holds it; absent (an
// older host) reads as null. A card carries a hold of its own when its conversion failed
// (`send_failed`) or the host kept it unsent (`kept`). The host mechanism lands first; the constant
// gates the rollout.
export const AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY =
  'agent-session.queued-messages.v1' as const
// Why: a host advertising this edits a queued card in place (`agentSession.queuedMessageUpdate`)
// and holds it from automatic delivery while edited (`agentSession.queuedMessageEditHold`). Apart
// from queued-messages.v1: kept and agent-mail cards are editable with mid-turn queueing still off.
// A client offers Edit only when the host advertises it; there is no copy-and-delete fallback.
export const AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY =
  'agent-session.queued-message-edit.v1' as const
// Why: a client advertising this shows a queued card's images and edits its text in place, keeping
// them. Released readers show only a card's text and edit by copying it and deleting the card, which
// would drop the images, so the host publishes no card holding an image to a reader without it.
export const AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY =
  'agent-session.queued-image-cards.v1' as const
// Why: `agentSession.conversationCommand`'s params are strict, so an older host rejects
// `delivery`. A host advertising this holds a /compact sent while the agent works as a queued
// card instead of refusing it. Clients ask only when queued-messages.v1 is advertised too:
// the card is the only place the waiting command shows.
export const AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY =
  'agent-session.queued-commands.v1' as const
// Why: paired clients advertise Claude-structured support so the host can gate its agent-specific
// journal and lifecycle surfaces independently from Codex support.
export const CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY =
  'agent-session.structured.claude.v1' as const
// Why: agentSession.conversationOutline is additive; a client probes this before calling so an
// older host leaves the message rail on loaded messages instead of answering method_not_found.
export const AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY =
  'agent-session.conversation-outline.v1' as const
// The RPC is registered unconditionally; per-session rewind support is a separate check.
export const AGENT_SESSION_REWIND_RUNTIME_CAPABILITY = 'agent-session.rewind.v1' as const
// Why: the rewind UI relies on the next send settling an in-doubt rewind, even with the agent up.
export const AGENT_SESSION_REWIND_RECOVERY_CAPABILITY = 'agent-session.rewind-recovery.v1' as const
// Readers must understand a monitoring roster with no available stop control.
// Why: a `turn` journal item replaced the status row that used to carry a turn's lifecycle. A
// client that predates it would render the unknown kind as text, so the host publishes the legacy
// status form to clients that do not advertise this. Transitional: drop the downgrade once no
// supported release lacks the capability.
export const AGENT_SESSION_TURN_ITEM_CAPABILITY = 'agent-session.turn-item.v1' as const
/** The client retires acknowledged echoes even when a catch-up snapshot skips their rows. */
export const AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY =
  'agent-session.snapshot-catch-up.v1' as const
export const AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY =
  'agent-session.background-task-stop.v1' as const
// Why: agentSession.respondToQuestion has a strict schema, so clients must not send structured
// `answers` to an older host; they fall back to the answer packed into `optionId`.
export const AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY =
  'agent-session.question-answers.v1' as const
// Why: a structured chat on a paired server stores attached files on that server
// (agentSessionAttachment.*); an older server has no store, so clients must refuse
// the attach rather than hand the agent a path from this machine.
export const AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY = 'agent-session.attachments.v1' as const
// Why: the host now publishes rows for work that is live inside a turn, and such
// a row carries `stoppable: false` because no targeted stop can reach it. A
// reader that predates the field draws a per-row Stop on every row it is given,
// so it must be told apart from one that honours the field — and NOT by the
// stop capability above, which a client can advertise while predating this.
export const AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY =
  'agent-session.background-task-row-stop.v1' as const
// Why: older runtimes strip mutation owner fields, so clients must fence writes before RPC.
export const FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY = 'files.mutation-ownership.v1' as const
export const FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE =
  'Remote file changes require a newer Orca server. Update the HUB and try again.'
export const GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY = 'github.markPRReadyForReview' as const
export const GITHUB_MARK_PR_READY_UPDATE_REQUIRED_MESSAGE =
  'Marking a pull request ready requires a newer Orca server. Update the server and try again.'
export const GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY =
  'gitlab.updateMR.readyForReview.v1' as const
export const GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE =
  'Marking a merge request ready requires a newer Orca server. Update the server and try again.'
export const WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-defaults.v1' as const
export const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-source-defaults.v1' as const
// Why: Git's checkout delete outlives worktree.rm's older client timeouts. A client with this waits
// for the reply and shows `removing` rows as Deleting; one without it is answered on acceptance and
// would re-show that row as a normal workspace, so the host leaves such rows out of its listings.
export const WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY =
  'worktree.background-removal.v1' as const
// Why: older hosts discard preflight.detectAgents params and probe their own PATH, so a client
// must not read that answer as the workspace's (a WSL project on a Windows host differs).
export const PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY =
  'preflight.workspace-scoped.v1' as const
// Why: an older host answers its own agents for a workspace another runtime owns; one with this
// refuses with WORKSPACE_ON_OTHER_RUNTIME, so a client may let it decide for a shared repo id.
export const PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY =
  'preflight.other-runtime-refusal.v1' as const
/** What such a host answers, instead of probing itself, for another runtime's workspace. */
export const WORKSPACE_ON_OTHER_RUNTIME = 'workspace_on_other_runtime'
// Hosts without this capability have no workspacePorts.scanHost/killHost; their scan and Stop act
// only on the endpoint itself, never on a workspace's SSH host.
export const WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY =
  'workspace-ports.host-scoped.v1' as const
// Hosts without this capability ignore a request's expectedRuntimeSource; the CLI's pre-send probe
// is then the only fence.
export const RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY = 'runtime-source-fence.v1' as const
// Hosts without this capability have no notifications.registerPush RPC.
export const NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1' as const

export const ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY =
  'git.antigravity-configured-model.v1' as const
