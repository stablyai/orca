import type { AgentMainAgentStatus, ParsedAgentStatusPayload } from '../agent-status-types'
import type { JcodeSubagentRoster } from '../jcode-subagent-roster'
import type {
  ClaudeLeadTurnState,
  CodexLeadTurnState,
  GrokActiveTurn,
  HermesPaneTurn,
  JcodeTurnAdmission
} from './main-agent-turn-state'

import type { ClaudeLaunchedBackgroundTasks } from '../claude-owed-task-notifications'
import type { ClaudeSubagentRoster } from '../claude-subagent-roster'
import type { CodexSubagentRoster } from '../codex-subagent-roster'
import type { CodexSubagentTranscriptState } from '../codex-subagent-transcript'
import type { MuseSessionLogState } from '../muse-session-log'
import type { AgentHookEventPayload, ToolSnapshot } from './listener-event'
import type { JcodeUserPromptEvidence } from '../jcode-session-files'
import type { JcodeDisplayBinding, JcodeTabOwner } from './jcode-display-registry'
import type { JcodeSessionRegistry } from './jcode-session-registry'
import type { OpenCodeSessionBinding } from './opencode-session-registry'

/** Per-listener-instance caches needing per-PTY teardown; Orca's main process and the relay each get their own, never shared. */
export type HookListenerState = {
  warnedVersions: Set<string>
  warnedEnvs: Set<string>
  lastPromptByPaneKey: Map<string, string>
  lastToolByPaneKey: Map<string, ToolSnapshot>
  /** Read-only compatibility view. All writes pass through the isolated legacy adapter. */
  lastStatusByPaneKey: ReadonlyMap<string, AgentHookEventPayload>
  antigravityCompletedTranscriptByPaneKey: Map<string, string>
  /** Conversation that spawned in-process subagents; kept until its fully idle Stop because children outlive its turns. */
  antigravitySubagentParentByPaneKey: Map<string, string>
  /** Journal-backed prompt for each jcode pane's current turn; see readJcodeTurnPrompt. */
  jcodeTurnPromptByPaneKey: Map<string, JcodeUserPromptEvidence | null>
  jcodeTurnByPaneKey: Map<string, JcodeTurnAdmission>
  jcodeSessions: JcodeSessionRegistry
  jcodeTabOwners: Map<string, JcodeTabOwner>
  jcodeDisplayBindings: Map<string, JcodeDisplayBinding>
  jcodeSubagentRosterByPaneKey: Map<string, JcodeSubagentRoster>
  jcodeRootPayloadByPaneKey: Map<string, ParsedAgentStatusPayload>
  /** Shared by copied listener views; survives all pane/cache teardown. */
  jcodeTurnRevision: { current: number }
  ampCompletedCacheKeys: Set<string>
  /** Live subagents/teammates per Claude pane; survives turn boundaries since background children outlive the lead turn. */
  claudeSubagentRosterByPaneKey: Map<string, ClaudeSubagentRoster>
  /** Lead-only state published as mainAgent; retain verdict through child churn until final done. */
  claudeLeadStateByPaneKey: Map<string, ClaudeLeadTurnState>
  /** One-normalization provenance marker for a status backed only by restored child state. */
  claudeUnconfirmedRestoredStatusPaneKeys: Set<string>
  /** Panes whose latest authoritative Claude task inventory still has running non-agent work. */
  claudeRunningNonAgentTaskPaneKeys: Set<string>
  /** Panes whose latest authoritative Claude cron inventory still has a scheduled job. */
  claudeActiveSessionCronPaneKeys: Set<string>
  /** Background tasks each pane's main agent launched, and which of them still owe it a notification. */
  claudeLaunchedBackgroundTasksByPaneKey: Map<string, ClaudeLaunchedBackgroundTasks>
  /** Compact whose completion each pane already applied, so relay duplicates can't refresh the row. */
  claudeConsumedCompactPromptIdByPaneKey: Map<string, string>
  /** Lead session_id changes retire replaced-conversation claims even without SessionStart (/clear/relaunch/resume). */
  claudeSessionOwnerByPaneKey: Map<string, string>
  /** Live thread-spawn children per Codex pane. */
  codexSubagentRosterByPaneKey: Map<string, CodexSubagentRoster>
  /** Incremental parent/child rollout cursors for Codex collaboration v2. */
  codexSubagentTranscriptByPaneKey: Map<string, CodexSubagentTranscriptState>
  /** Root Codex state/model, kept separate from child hook traffic. */
  codexLeadStateByPaneKey: Map<string, CodexLeadTurnState>
  /** Ephemeral forked Codex threads (/side) per pane; they never own the pane's status. */
  codexEphemeralForkSessionsByPaneKey: Map<string, string[]>
  /** A rollout-less Codex start held until its prompt shows a new conversation or the hidden title thread. */
  codexHeldEphemeralStartByPaneKey: Map<string, string>
  /** Newest Grok turn per pane, used to reject end reports that arrive after a replacement prompt. */
  grokActiveTurnByPaneKey: Map<string, GrokActiveTurn>
  /** The Grok main agent's own state as last published, so its clock keeps continuity across events. */
  grokMainAgentStatusByPaneKey: Map<string, AgentMainAgentStatus>
  /** Muse child-session filter and session-log cursor per pane. */
  musePaneStateByPaneKey: Map<string, MusePaneState>
  /** Client-observed OpenCode1 session ownership replaces frozen shared-server stamps before ingest. This map names owners, not status claims. */
  opencodeSessionPaneBySessionId: Map<string, OpenCodeSessionBinding>
  /** Last launch token seen per pane; a rewritten shared-server post needs the bound pane's live token to pass its fence. */
  lastLaunchTokenByPaneKey: Map<string, string>
  /** Hermes turn per pane, so tool hooks from its post-turn background review can be ignored. */
  hermesTurnByPaneKey: Map<string, HermesPaneTurn>
}

export type MusePaneState = {
  /** Internal reminder/subagent sessions; their hooks inherit the pane env and fire even after Stop. */
  childSessionIds: Set<string>
  log?: MuseSessionLogState
  /** Muse emits PermissionRequest for auto-approved calls too; only Notification confirms a visible prompt. */
  pendingApproval?: { toolName?: string; toolInput?: unknown }
}
