import { z } from 'zod'
import { AGENT_STATUS_STATES, type AgentStatusEntry } from '../../../shared/agent-status-types'
import { AGENT_STATUS_OBSERVATION_ORIGINS } from '../../../shared/agent-status-observation'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import { TERMINAL_COLOR_KEYS } from '../../../shared/terminal-custom-themes'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'

const identity = z.string().refine((value) => value.trim().length > 0)
const optionalString = z.string().optional()
const optionalBoolean = z.boolean().optional()
const optionalNumber = z.number().finite().optional()
const nullableString = z.string().nullable()
const version = z.number().int().nonnegative()
const tabType = z.enum(['terminal', 'markdown', 'file', 'browser', 'agent-session'])
const direction = z.enum(['horizontal', 'vertical'])
const ratio = z.number().min(0).max(1).optional()

const paneLayout: z.ZodType<TerminalPaneLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('leaf'), leafId: identity }),
    z.object({ type: z.literal('split'), direction, first: paneLayout, second: paneLayout, ratio })
  ])
)
const groupLayout: z.ZodType<TabGroupLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('leaf'), groupId: identity }),
    z.object({
      type: z.literal('split'),
      direction,
      first: groupLayout,
      second: groupLayout,
      ratio
    })
  ])
)
const leafStrings = z.record(z.string(), z.string()).optional()
const parentLayout = z.object({
  root: paneLayout.nullable(),
  activeLeafId: nullableString,
  expandedLeafId: nullableString,
  ptyIdsByLeafId: leafStrings,
  buffersByLeafId: leafStrings,
  scrollbackRefsByLeafId: leafStrings,
  titlesByLeafId: leafStrings
})
const agentState = z.enum(AGENT_STATUS_STATES)
const agentStatus: z.ZodType<AgentStatusEntry> = z.object({
  state: agentState,
  prompt: z.string(),
  updatedAt: z.number().finite(),
  stateStartedAt: z.number().finite(),
  paneKey: identity,
  stateHistory: z.array(
    z.object({
      state: agentState,
      prompt: z.string(),
      startedAt: z.number().finite(),
      interrupted: optionalBoolean
    })
  ),
  workingMode: z.literal('monitoring').optional(),
  evidenceObservedAt: optionalNumber,
  agentType: identity.optional(),
  model: optionalString,
  terminalHandle: optionalString,
  worktreeId: optionalString,
  connectionId: nullableString.optional(),
  tabId: optionalString,
  terminalTitle: optionalString,
  toolName: optionalString,
  toolInput: optionalString,
  interactivePrompt: optionalString,
  lastAssistantMessage: optionalString,
  lastAssistantMessageIsToolOutput: optionalBoolean,
  lastCompletedAssistantMessage: optionalString,
  interrupted: optionalBoolean,
  sessionBoundary: optionalBoolean,
  terminalResumeEligible: z.literal(false).optional(),
  promptInteractionKey: optionalString,
  restoredUnconfirmed: optionalBoolean,
  mirroredEvidenceReceivedAt: optionalNumber,
  acceptedStatusSeq: version.optional(),
  orchestration: z
    .object({
      taskId: identity,
      dispatchId: identity,
      dispatchStatus: z
        .enum(['pending', 'dispatched', 'completed', 'failed', 'circuit_broken'])
        .optional(),
      taskTitle: optionalString,
      displayName: optionalString,
      parentTerminalHandle: optionalString,
      parentPaneKey: optionalString,
      coordinatorHandle: optionalString,
      orchestrationRunId: optionalString
    })
    .optional(),
  subagents: z
    .array(
      z.object({
        id: identity,
        agentType: optionalString,
        model: optionalString,
        description: optionalString,
        state: z.enum(['working', 'blocked', 'waiting', 'idle']),
        startedAt: z.number().finite()
      })
    )
    .optional(),
  providerSession: z
    .object({
      key: z.enum(['session_id', 'conversation_id']),
      id: identity,
      transcriptPath: optionalString
    })
    .optional(),
  observation: z
    .object({
      origin: z.enum(AGENT_STATUS_OBSERVATION_ORIGINS),
      authorityId: identity,
      incarnation: version,
      revision: version,
      observedAt: z.number().finite(),
      boundary: z.literal(true).optional(),
      kind: z.enum(['transition', 'snapshot', 'identity-only']).optional()
    })
    .optional()
})
const tabFields = {
  id: identity,
  title: z.string(),
  isActive: z.boolean(),
  color: nullableString.optional(),
  isPinned: optionalBoolean
}
const terminalTab = z.object({
  ...tabFields,
  type: z.literal('terminal'),
  parentTabId: identity,
  leafId: identity,
  quickCommandLabel: nullableString.optional(),
  ptyId: nullableString.optional(),
  incarnationId: nullableString.optional(),
  terminalTheme: z
    .object({
      mode: z.enum(['dark', 'light']),
      theme: z.object(Object.fromEntries(TERMINAL_COLOR_KEYS.map((key) => [key, optionalString])))
    })
    .optional(),
  agentStatus: agentStatus.nullable().optional(),
  turnCompletedAt: optionalNumber,
  launchAgent: z.custom<TuiAgent>(isTuiAgent).optional(),
  startupCwd: optionalString,
  parentLayout: parentLayout.optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  launchDraft: optionalString,
  launchDraftCreatedAt: optionalNumber
})
const fileFields = {
  ...tabFields,
  filePath: z.string(),
  relativePath: z.string(),
  isDirty: z.boolean()
}
const snapshotSchema: z.ZodType<RuntimeMobileSessionTabsResult> = z.object({
  worktree: identity,
  publicationEpoch: identity,
  snapshotVersion: version,
  navigationIntent: z.literal('follow').optional(),
  activeGroupId: nullableString,
  activeTabId: nullableString,
  activeTabType: tabType.nullable(),
  clientHostedPagesUnreconciled: z.literal(true).optional(),
  tabGroups: z
    .array(
      z.object({
        id: identity,
        activeTabId: nullableString,
        tabOrder: z.array(z.string()),
        recentTabIds: z.array(z.string()).optional()
      })
    )
    .optional(),
  tabGroupLayout: groupLayout.nullable().optional(),
  retiredTerminalSurfaces: z
    .array(
      z.object({
        parentTabId: identity,
        leafId: identity,
        ptyId: identity,
        terminal: identity,
        incarnationId: identity.optional()
      })
    )
    .optional(),
  tabs: z.array(
    z.discriminatedUnion('type', [
      z.discriminatedUnion('status', [
        terminalTab.extend({ status: z.literal('pending-handle'), terminal: z.null() }),
        terminalTab.extend({ status: z.literal('ready'), terminal: identity })
      ]),
      z.object({
        ...fileFields,
        type: z.literal('markdown'),
        language: z.literal('markdown'),
        mode: z.enum(['edit', 'markdown-preview']),
        sourceFileId: z.string(),
        sourceFilePath: z.string(),
        sourceRelativePath: z.string(),
        documentVersion: z.string()
      }),
      z.object({
        ...fileFields,
        type: z.literal('file'),
        language: z.string(),
        mode: z.enum(['edit', 'diff']).optional(),
        diffSource: z.enum(['staged', 'unstaged']).optional()
      }),
      z.object({
        ...tabFields,
        type: z.literal('browser'),
        browserWorkspaceId: identity,
        browserPageId: nullableString,
        browserProfileId: optionalString,
        executionHostKey: optionalString,
        url: z.string(),
        loading: z.boolean(),
        canGoBack: z.boolean(),
        canGoForward: z.boolean(),
        placement: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('server') }),
            z.object({
              kind: z.literal('client'),
              browserHostClientId: identity,
              browserHostGeneration: version,
              pageHostGeneration: version
            })
          ])
          .optional(),
        loadError: z
          .object({ code: z.number().finite(), description: z.string(), validatedUrl: z.string() })
          .nullable()
          .optional(),
        certificateFailure: z
          .object({
            challengeId: identity,
            browserPageId: identity,
            errorCode: z.number().finite().nullable(),
            error: z.string(),
            origin: z.string(),
            displayHost: z.string(),
            canProceed: z.boolean(),
            observedAt: z.number().finite()
          })
          .nullable()
          .optional()
      }),
      z.object({
        ...tabFields,
        type: z.literal('agent-session'),
        sessionId: identity,
        agent: z.enum(['claude', 'codex'])
      })
    ])
  )
})

export function isTerminalRecoverySnapshot(
  value: unknown
): value is RuntimeMobileSessionTabsResult {
  try {
    // Validate without replacing the payload: additive fields survive, malformed rows never get salvaged.
    return snapshotSchema.safeParse(value).success
  } catch {
    return false
  }
}
