import { z } from 'zod'
import { TERMINAL_KITTY_FILE_MAX_BYTES } from '../terminal-kitty-file'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'
import { isTuiAgent } from '../tui-agent-config'
import { SpawnIntentParam } from './agent-session-params'
import {
  canonicalizeWindowsShellOverride,
  isSupportedWindowsShellOverride,
  listSupportedWindowsShellOverrides
} from '../windows-terminal-shell'
import { TERMINAL_PANE_SPLIT_SOURCES } from '../feature-education-telemetry'
import { OptionalExecutionHostId } from './worktree-params'

// Refuse at the authoritative host boundary instead of returning an opaque relay spawn failure.
export const WindowsShellOverrideParam = z
  .string()
  .refine(isSupportedWindowsShellOverride, {
    message: `shell must be one of: ${listSupportedWindowsShellOverrides().join(', ')}`
  })
  // Canonicalize host-side to the .exe spellings exact-matched by spawn, even if the client did not.
  .transform((shell) => canonicalizeWindowsShellOverride(shell) ?? shell)

const TerminalSurfaceCloseIdentity = z.object({
  worktreeId: requiredString('Missing worktree id'),
  tabId: requiredString('Missing tab id'),
  leafId: requiredString('Missing leaf id'),
  createdAt: z.number().finite().nullable(),
  generation: z.number().int().nonnegative(),
  hasLeaf: z.boolean(),
  ptyId: z.string().nullable(),
  incarnationId: z.string().nullable()
})
const TerminalSurfaceCloseCapture = z.object({
  identity: TerminalSurfaceCloseIdentity,
  holders: z
    .array(
      z.object({
        hostId: OptionalExecutionHostId.unwrap(),
        identity: TerminalSurfaceCloseIdentity.nullable()
      })
    )
    .max(64)
})

export const TerminalHandle = z.object({
  terminal: requiredString('Missing terminal handle'),
  // Additive fence understood by newer hosts; legacy hosts safely ignore it.
  expectedIncarnationId: requiredString('Missing PTY incarnation').optional()
})

export const TerminalClose = TerminalHandle.extend({
  originalPresentation: TerminalSurfaceCloseCapture.optional()
})

export const TerminalReadKittyFile = TerminalHandle.extend({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => !path.includes('\0')),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  length: z.number().int().nonnegative().max(TERMINAL_KITTY_FILE_MAX_BYTES).optional()
})

export const TerminalFocus = TerminalHandle.extend({
  navigation: z.enum(['caller', 'host']).optional()
})

export const TerminalViewClaudeAgent = TerminalHandle.extend({
  sessionId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256).optional(),
  client: z.object({ id: z.string().min(1).max(256), type: z.literal('desktop') })
})

/** `terminal.reveal` takes no handle: a pane a paired server owns has none on this host. */
export const TerminalReveal = z.object({
  worktreeId: requiredString('Missing worktree id').pipe(z.string().max(1024)),
  tabId: requiredString('Missing tab id').pipe(z.string().max(128)),
  leafId: requiredString('Missing leaf id').pipe(z.string().max(128)).optional(),
  executionHostId: OptionalExecutionHostId
})

/** Only inspectProcess accepts the decision-bearing process scan; sibling handle methods must not acquire this option. */
export const TerminalInspectProcess = TerminalHandle.extend({
  // Additive request member understood by newer hosts; legacy hosts safely ignore it.
  scanChildProcesses: z.boolean().optional()
})

export const TerminalListParams = z.object({
  worktree: OptionalString,
  limit: OptionalFiniteNumber,
  handles: z
    .array(requiredString('Missing terminal handle').pipe(z.string().max(256)))
    .max(64)
    .optional(),
  requireFreshPtyLiveness: z.boolean().optional(),
  // Only human CLI formatting needs the costly layouts; absent includes them for older clients.
  includeVisualLayouts: z.boolean().optional(),
  // Layout-owner hosts show the workspace's unshown live terminals before listing (a window's
  // activation sweep); other hosts drop it, as they did before it existed.
  placeUnshownLiveTerminals: z.boolean().optional()
})

export const TerminalResolveActive = z.object({
  worktree: OptionalString,
  /** Refuse instead of guessing when several leaves could be the caller's own terminal. */
  requireUnambiguous: z.boolean().optional()
})

export const TerminalResolvePane = z.object({
  paneKey: requiredString('Missing pane key'),
  worktreeId: OptionalString
})

export const TerminalRecoverPane = z.object({
  paneKey: requiredString('Missing pane key'),
  worktreeId: requiredString('Missing worktree ID'),
  expectedTerminal: requiredString('Missing expected terminal handle').optional()
})

export const TerminalRead = TerminalHandle.extend({
  cursor: z
    .unknown()
    .transform((value) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return Number.NaN
      }
      return value
    })
    .pipe(
      z
        .number()
        .optional()
        .refine((v) => v === undefined || Number.isFinite(v), {
          message: 'Cursor must be a non-negative integer'
        })
    )
    .optional(),
  limit: OptionalFiniteNumber,
  // Old hosts strip screen and return streams; callers must read response.source.
  screen: z.literal(true).optional()
}).refine((params) => !(params.screen === true && params.cursor !== undefined), {
  // Cursor pages accumulated output; screen is one current frame. Mixing them would attach misleading stream pagination metadata.
  message: 'Cursor cannot be combined with a screen read'
})

// Why: preserve the legacy contract — `title: string | null` only, `undefined` rejected, so the CLI's "reset" signal stays distinct.
export const TerminalRename = TerminalHandle.extend({
  title: z.custom<string | null>((value) => value === null || typeof value === 'string', {
    message: 'Missing --title (pass empty string or null to reset)'
  })
})

// An explicit empty string clears the pane; an omitted title must not clear it.
export const TerminalSetPaneTitle = TerminalHandle.extend({
  title: z.string()
})

export const TerminalSend = TerminalHandle.extend({
  text: OptionalString,
  enter: z.unknown().optional(),
  interrupt: z.unknown().optional(),
  // Why: older hosts strip this optional intent and retain their direct-send behavior.
  agentPrompt: z.literal(true).optional(),
  // Older hosts strip this and omit the proof; callers read their whole-write `accepted` verdict.
  requireWriteSettlement: z.literal(true).optional(),
  // Why: waiting observes the same prompt receipt; it never authorizes a second write.
  waitSubmitMs: z.number().int().min(0).max(3_600_000).optional(),
  resolvedLaunchDraft: z
    .object({
      text: z.string(),
      createdAt: z.number().finite()
    })
    .optional(),
  requireAgentStatus: z.enum(['sendable']).optional(),
  // Why: terminal-generated replies are valid input but must not transfer the shared terminal floor.
  inputKind: z.enum(['query-reply']).optional(),
  // Identify the driver; older clients fall back to the latest mobile actor (docs/mobile-presence-lock.md).
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional(),
  viewport: z
    .object({
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(500)
    })
    .optional(),
  claimViewport: z.literal(true).optional()
})

export const TerminalViewport = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500)
})

export const TerminalWait = TerminalHandle.extend({
  for: z.custom<'exit' | 'tui-idle'>((value) => value === 'exit' || value === 'tui-idle', {
    message: 'Invalid --for value. Supported: exit, tui-idle'
  }),
  timeoutMs: OptionalFiniteNumber
})

const TerminalColorQueryReplyColorsParam = z.object({
  foreground: z.string().max(128).optional(),
  background: z.string().max(128).optional()
})

export const TerminalSetViewerColors = z.object({
  colors: TerminalColorQueryReplyColorsParam
})

/** The provider session a terminal's launch resumes. */
export const ResumeProviderSessionParam = z.object({
  key: z.enum(['session_id', 'conversation_id']),
  id: z.string().min(1).max(512),
  transcriptPath: z.string().min(1).max(32_768).optional()
})

export const TerminalCreateParams = z.object({
  worktree: OptionalString,
  clientMutationId: z.string().min(1).max(128).optional(),
  reconcileExisting: z.boolean().optional(),
  command: OptionalString,
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  env: z.record(z.string(), z.string()).optional(),
  envToDelete: z.array(z.string().min(1).max(256)).max(32).optional(),
  launchConfig: z
    .object({
      agentCommand: z.string().optional(),
      agentArgs: z.string(),
      agentEnv: z.record(z.string(), z.string()),
      ompResumeFilePath: z
        .string()
        .min(1)
        .max(32 * 1024)
        .optional()
    })
    .optional(),
  resumeProviderSession: ResumeProviderSessionParam.optional(),
  // Older hosts drop it and resume as before.
  resumeOrigin: z.literal('saved').optional(),
  launchToken: OptionalString,
  launchAgent: z.string().refine(isTuiAgent).optional(),
  terminalKittyKeyboardProtocol: z.boolean().optional(),
  terminalColorQueryReplies: TerminalColorQueryReplyColorsParam.optional(),
  title: OptionalString,
  focus: z.unknown().optional(),
  // Ignored here; the CLI still sends it for hosts before v1.4.211, which route on it.
  rendererBacked: z.unknown().optional(),
  activate: z.unknown().optional(),
  presentation: z.enum(['background', 'focused']).optional(),
  tabId: OptionalString,
  leafId: OptionalString,
  spawnIntent: SpawnIntentParam.optional(),
  shell: WindowsShellOverrideParam.optional(),
  // Local layout-owner window already wrote tabId/leafId to main; main starts its first pane.
  windowTab: z.literal(true).optional(),
  cwd: OptionalString
})

export const TerminalSplit = z
  .object({
    // Required unless `pane` names the source; the refinement keeps the handle's message.
    terminal: OptionalString,
    expectedIncarnationId: TerminalHandle.shape.expectedIncarnationId,
    direction: z
      .unknown()
      .transform((v) => (v === 'vertical' || v === 'horizontal' ? v : undefined))
      .pipe(z.union([z.enum(['vertical', 'horizontal']), z.undefined()]))
      .optional(),
    command: OptionalString,
    env: z.record(z.string(), z.string()).optional(),
    telemetrySource: z.enum(TERMINAL_PANE_SPLIT_SOURCES).optional(),
    // Timed-out split identity, gated on TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY; reject blank rather than treating it as a fresh split.
    retrySplit: z.string().min(1, 'Missing split id').optional(),
    // Layout-owner build: a window names its own pane; main writes the split and starts it.
    pane: z
      .object({
        worktreeId: requiredString('Missing worktree'),
        tabId: requiredString('Missing tab'),
        leafId: requiredString('Missing pane')
      })
      .optional(),
    newLeafId: OptionalString,
    cwd: OptionalString,
    initialSize: z
      .object({
        cols: z.number().int().min(1).max(1000),
        rows: z.number().int().min(1).max(500)
      })
      .optional()
  })
  .superRefine((params, ctx) => {
    if (!params.terminal && !params.pane) {
      ctx.addIssue({ code: 'custom', message: 'Missing terminal handle', path: ['terminal'] })
    }
  })

export const TerminalStop = z.object({
  worktree: requiredString('Missing worktree selector')
})

export const TerminalCloseAll = TerminalStop

export const TerminalSleep = TerminalStop

export const TerminalStopExact = TerminalStop.extend({
  expectedPtyIds: z.array(requiredString('Missing PTY ID')).min(1),
  keepHistory: z.boolean().optional(),
  targetOnly: z.boolean().optional()
})

export const AgentTeamsTmuxCompat = z.object({
  teamId: requiredString('Missing agent team ID'),
  token: requiredString('Missing agent team token'),
  envPane: requiredString('Missing tmux pane identity'),
  cwd: OptionalString,
  argv: z.array(z.string())
})

export const AgentTeamsPrepareLaunch = z.object({
  paneKey: requiredString('Missing pane key'),
  env: z.record(z.string(), z.string()).optional(),
  prepareAuth: z.boolean().optional()
})
