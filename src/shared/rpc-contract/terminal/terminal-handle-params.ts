import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { TERMINAL_KITTY_FILE_MAX_BYTES } from '../../terminal/images/terminal-kitty-file'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'
import { OptionalExecutionHostId } from '../workspaces/worktree-params'
import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from '../../agent-status/contracts/agent-status-types'

const TerminalSurfaceCloseIdentity = lazyZodSchema(() =>
  z.object({
    worktreeId: requiredString('Missing worktree id'),
    tabId: requiredString('Missing tab id'),
    leafId: requiredString('Missing leaf id'),
    createdAt: z.number().finite().nullable(),
    generation: z.number().int().nonnegative(),
    hasLeaf: z.boolean(),
    ptyId: z.string().nullable(),
    incarnationId: z.string().nullable()
  })
)

const TerminalSurfaceCloseCapture = lazyZodSchema(() =>
  z.object({
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
)

export const TerminalHandle = lazyZodSchema(() =>
  z.object({
    terminal: requiredString('Missing terminal handle'),
    // Additive fence understood by newer hosts; legacy hosts safely ignore it.
    expectedIncarnationId: requiredString('Missing PTY incarnation').optional()
  })
)

export const TerminalClose = lazyZodSchema(() =>
  TerminalHandle.extend({
    originalPresentation: TerminalSurfaceCloseCapture.optional()
  })
)

export const TerminalReadKittyFile = lazyZodSchema(() =>
  TerminalHandle.extend({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !path.includes('\0')),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    length: z.number().int().nonnegative().max(TERMINAL_KITTY_FILE_MAX_BYTES).optional()
  })
)

export const TerminalFocus = lazyZodSchema(() =>
  TerminalHandle.extend({
    navigation: z.enum(['caller', 'host']).optional()
  })
)

export const TerminalViewClaudeAgent = lazyZodSchema(() =>
  TerminalHandle.extend({
    sessionId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256).optional(),
    client: z.object({ id: z.string().min(1).max(256), type: z.literal('desktop') })
  })
)

/** `terminal.reveal` takes no handle: a pane a paired server owns has none on this host. */
export const TerminalReveal = lazyZodSchema(() =>
  z.object({
    worktreeId: requiredString('Missing worktree id').pipe(z.string().max(1024)),
    tabId: requiredString('Missing tab id').pipe(z.string().max(128)),
    leafId: requiredString('Missing leaf id').pipe(z.string().max(128)).optional(),
    executionHostId: OptionalExecutionHostId
  })
)

/** Only inspectProcess accepts the decision-bearing process scan; sibling handle methods must not acquire this option. */
export const TerminalInspectProcess = lazyZodSchema(() =>
  TerminalHandle.extend({
    // Additive request member understood by newer hosts; legacy hosts safely ignore it.
    scanChildProcesses: z.boolean().optional()
  })
)

export const TerminalListParams = lazyZodSchema(() =>
  z.object({
    worktree: OptionalString,
    limit: OptionalFiniteNumber,
    handles: z
      .array(requiredString('Missing terminal handle').pipe(z.string().max(256)))
      .max(64)
      .optional(),
    requireFreshPtyLiveness: z.boolean().optional(),
    // Only human CLI formatting needs the costly layouts; absent includes them for older clients.
    includeVisualLayouts: z.boolean().optional(),
    // Readers that never show the output tail drop it; absent includes it, as older hosts always do.
    includePreview: z.boolean().optional(),
    // Agent sleep asks who else is viewing or typing; older hosts ignore it and report nothing.
    includeAttention: z.boolean().optional(),
    // Layout-owner hosts show the workspace's unshown live terminals before listing (a window's
    // activation sweep); other hosts drop it, as they did before it existed.
    placeUnshownLiveTerminals: z.boolean().optional()
  })
)

export const TerminalResolveActive = lazyZodSchema(() =>
  z.object({
    worktree: OptionalString,
    /** Refuse instead of guessing when several leaves could be the caller's own terminal. */
    requireUnambiguous: z.boolean().optional()
  })
)

export const TerminalResolvePane = lazyZodSchema(() =>
  z.object({
    paneKey: requiredString('Missing pane key'),
    worktreeId: OptionalString
  })
)

export const TerminalAgentId = lazyZodSchema(() =>
  z.object({
    paneKey: requiredString('Missing pane key'),
    worktreeId: requiredString('Missing worktree ID')
  })
)

export const TerminalRecoverPane = lazyZodSchema(() =>
  z.object({
    paneKey: requiredString('Missing pane key'),
    worktreeId: requiredString('Missing worktree ID'),
    expectedTerminal: requiredString('Missing expected terminal handle').optional()
  })
)

export const TerminalRead = lazyZodSchema(() =>
  TerminalHandle.extend({
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
)

// Why: preserve the legacy contract — `title: string | null` only, `undefined` rejected, so the CLI's "reset" signal stays distinct.
export const TerminalRename = lazyZodSchema(() =>
  TerminalHandle.extend({
    title: z.custom<string | null>((value) => value === null || typeof value === 'string', {
      message: 'Missing --title (pass empty string or null to reset)'
    })
  })
)

// An explicit empty string clears the pane; an omitted title must not clear it.
export const TerminalSetPaneTitle = lazyZodSchema(() =>
  TerminalHandle.extend({
    title: z.string()
  })
)

export const TerminalSend = lazyZodSchema(() =>
  TerminalHandle.extend({
    inputSequence: z
      .object({
        sessionId: z.string().min(1).max(128),
        seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
      })
      .optional(),
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
    // A startup-dialog card's choice: refused unless the screen still reads as this card. Older hosts strip it.
    requireStartupDialog: z
      .string()
      .min(1)
      .max(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
      .optional(),
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
)

export const TerminalOpenInputSession = lazyZodSchema(() =>
  TerminalHandle.extend({
    client: z.object({ id: requiredString('Missing client ID'), type: z.literal('mobile') })
  })
)

export const TerminalViewport = lazyZodSchema(() =>
  z.object({
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(500)
  })
)

export const TerminalWait = lazyZodSchema(() =>
  TerminalHandle.extend({
    for: z.custom<'exit' | 'tui-idle'>((value) => value === 'exit' || value === 'tui-idle', {
      message: 'Invalid --for value. Supported: exit, tui-idle'
    }),
    timeoutMs: OptionalFiniteNumber
  })
)
