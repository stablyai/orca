import { z } from 'zod'
import { AGENT_STATUS_STATES } from '../agent-status-types'
import { RESUMABLE_TUI_AGENTS, hasUnsafeProviderSessionIdChars } from '../agent-session-resume'
import type {
  OrcaRecoveryDescriptorV1,
  RecoveryAgentBinding,
  RecoveryPresentationFocus,
  RecoveryPresentationViewExport,
  RecoveryWorkspaceMeta
} from '../cross-machine-recovery-descriptor'
import {
  MAX_RECOVERY_PRESENTATION_CLIENTS,
  MAX_RECOVERY_PRESENTATION_WORKSPACES,
  type RecoveryPresentationPublishParams,
  type RecoveryPresentationWorkspaceRef
} from '../cross-machine-recovery-presentation-types'
import { WorkspaceLinkedItemSchema } from '../workspace-linked-item-schema'
import {
  AgentArgs,
  LaunchPreferences,
  MAX_PROMPT_BYTES,
  Presentation,
  ProviderSession,
  StrictNonEmptyString,
  WorktreeSelector
} from './agent-session-params'
import {
  Id,
  Label,
  MAX_ID_LENGTH,
  MAX_PATH_LENGTH,
  PathId,
  RecoveryLayoutSchema,
  Timestamp,
  TuiAgentSchema,
  boundedRecord,
  utf8Text
} from './cross-machine-recovery-layout-params'
import { MAX_PANE_LAYOUT_NODES } from './session-tabs-schemas-params'

const MAX_COMMENT_BYTES = 64 * 1024
const MAX_RECOVERY_BINDINGS = 256
const MAX_RECOVERY_PATH_MAPPINGS = 64
const MAX_RECOVERY_ENV_KEYS = 256
const NODE_PLATFORMS = [
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32'
] as const satisfies readonly NodeJS.Platform[]

const EnvKey = z
  .string()
  .min(1)
  .max(1024)
  .refine((key) => !key.includes('=') && !hasUnsafeProviderSessionIdChars(key), 'Invalid env key')

const RecoveryAgentBindingSchema: z.ZodType<RecoveryAgentBinding> = z
  .object({
    sourcePaneKey: Id,
    sourceTabId: Id,
    sourceLeafId: Id.nullable(),
    surface: z.enum(['terminal', 'structured']),
    agent: z.enum(RESUMABLE_TUI_AGENTS),
    providerSession: ProviderSession,
    structuredCursor: z
      .object({ provider: z.literal('claude'), sessionId: Id, leafUuid: Id.nullable() })
      .strict()
      .optional(),
    liveness: z.enum(['live', 'sleeping', 'exited']),
    state: z.enum(AGENT_STATUS_STATES),
    launch: z
      .object({
        launchPreferences: LaunchPreferences.optional(),
        sourceAgentArgs: AgentArgs,
        sourceEnvKeys: z.array(EnvKey).max(MAX_RECOVERY_ENV_KEYS),
        accountHomeVariable: z.enum(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']).optional()
      })
      .strict(),
    terminalTitle: Label.optional(),
    prompt: utf8Text(MAX_PROMPT_BYTES).optional(),
    lastAssistantMessage: utf8Text(MAX_PROMPT_BYTES).optional(),
    capturedAt: Timestamp,
    updatedAt: Timestamp,
    lastHumanInputAt: Timestamp.nullable()
  })
  .strict()

export const RecoveryPresentationFocusSchema: z.ZodType<RecoveryPresentationFocus> = z
  .object({
    isActiveWorkspace: z.boolean(),
    focusedTabId: PathId.nullable(),
    focusedLeafId: Id.nullable(),
    focusedPaneKey: Id.nullable(),
    windowFocused: z.boolean()
  })
  .strict()

const RecoveryPresentationViewExportSchema: z.ZodType<RecoveryPresentationViewExport> = z
  .object({
    clientKey: Id,
    clientInstanceId: Id,
    clientName: Label,
    clientKind: z.enum(['local-renderer', 'paired-device']),
    hostReceivedAt: Timestamp,
    lastHumanInputAt: Timestamp.nullable(),
    lastHumanFocusAt: Timestamp.nullable(),
    focus: RecoveryPresentationFocusSchema,
    view: RecoveryLayoutSchema
  })
  .strict()

const RecoveryWorkspaceMetaSchema: z.ZodType<RecoveryWorkspaceMeta> = z
  .object({
    displayName: Label,
    comment: utf8Text(MAX_COMMENT_BYTES),
    linkedIssue: z.number().int().nullable(),
    linkedPR: z.number().int().nullable(),
    linkedLinearIssue: Id.nullable(),
    linkedWorkItem: WorkspaceLinkedItemSchema.nullable().optional(),
    baseRef: Label.optional(),
    createdWithAgent: TuiAgentSchema.optional(),
    lastActivityAt: Timestamp,
    isPinned: z.boolean()
  })
  .strict()

/** Untrusted cross-machine input: parse it in the import handler so failures map to
 *  recovery_descriptor_invalid rather than a generic params error. */
export const OrcaRecoveryDescriptorV1Schema: z.ZodType<OrcaRecoveryDescriptorV1> = z
  .object({
    version: z.literal(1),
    exportedAt: Timestamp,
    source: z
      .object({
        runtimeId: Id,
        appVersion: Label,
        machineName: Label,
        platform: z.enum(NODE_PLATFORMS),
        executionHostId: z.literal('local')
      })
      .strict(),
    repo: z
      .object({
        id: Id,
        path: PathId,
        displayName: Label,
        kind: z.enum(['git', 'folder']).optional(),
        upstream: z
          .object({ owner: Label, repo: Label, host: Label.optional() })
          .strict()
          .nullable()
          .optional(),
        worktreeBaseRef: Label.optional()
      })
      .strict(),
    workspace: z
      .object({
        worktreeId: PathId,
        instanceId: Id,
        path: PathId,
        branch: Label.nullable(),
        meta: RecoveryWorkspaceMetaSchema
      })
      .strict(),
    layout: RecoveryLayoutSchema,
    presentation: z
      .object({
        views: z.array(RecoveryPresentationViewExportSchema).max(MAX_RECOVERY_PRESENTATION_CLIENTS),
        preferredClientKey: Id.nullable(),
        freshness: z.enum(['client-view', 'host-only', 'host-bindings-only'])
      })
      .strict(),
    bindings: z.array(RecoveryAgentBindingSchema).max(MAX_RECOVERY_BINDINGS)
  })
  .strict()

const ProviderSessionId = ProviderSession.shape.id

export const CrossMachineRecoveryDescribeParams = z.object({}).strict().optional().default({})

export const CrossMachineRecoveryExportParams = z.object({ worktree: WorktreeSelector }).strict()

export const CrossMachineRecoveryImportParams = z
  .object({
    descriptor: z.unknown(),
    checkoutPath: StrictNonEmptyString(MAX_PATH_LENGTH, 'Invalid checkout path'),
    checkpointId: StrictNonEmptyString(MAX_ID_LENGTH, 'Invalid checkpoint ID'),
    pathMap: z
      .array(z.object({ from: PathId, to: PathId }).strict())
      .max(MAX_RECOVERY_PATH_MAPPINGS)
      .optional(),
    resume: z.array(ProviderSessionId).max(MAX_RECOVERY_BINDINGS).optional(),
    preferClientInstanceId: Id.optional(),
    activate: z.boolean().optional(),
    registerRepo: z.boolean().optional(),
    dryRun: z.boolean().optional()
  })
  .strict()

export const CrossMachineRecoveryResumeParams = z
  .object({
    worktree: WorktreeSelector,
    providerSessionId: ProviderSessionId,
    presentation: Presentation.optional()
  })
  .strict()

export const CrossMachineRecoveryListParams = z
  .object({ worktree: WorktreeSelector.optional() })
  .strict()

const MsAge = z.number().finite().nonnegative()

export const RecoveryPresentationWorkspaceRefSchema: z.ZodType<RecoveryPresentationWorkspaceRef> =
  z.discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('worktree'), worktreeId: PathId, instanceId: Id.optional() })
      .strict(),
    z.object({ kind: z.literal('folder'), folderWorkspaceId: PathId }).strict()
  ])

// Why the byte caps are not here: an oversized publish must answer {ok:false, reason:'too-large'}
// so the client can shed views; the host store enforces them.
export const CrossMachineRecoveryPresentationPublishParams: z.ZodType<RecoveryPresentationPublishParams> =
  z
    .object({
      clientInstanceId: Id,
      clientName: Label,
      clientRevision: z.number().int().nonnegative(),
      workspaces: z
        .array(
          z
            .object({
              workspace: RecoveryPresentationWorkspaceRefSchema,
              view: RecoveryLayoutSchema,
              focus: RecoveryPresentationFocusSchema,
              input: z
                .object({
                  msSinceHumanInput: MsAge.nullable(),
                  msSinceHumanFocus: MsAge.nullable(),
                  msSinceHumanInputByPaneKey: boundedRecord(MsAge, MAX_PANE_LAYOUT_NODES)
                })
                .strict()
            })
            .strict()
        )
        .max(MAX_RECOVERY_PRESENTATION_WORKSPACES)
    })
    .strict()
