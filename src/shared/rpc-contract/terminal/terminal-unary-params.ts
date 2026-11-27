import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalString, requiredString } from '../rpc-param-primitives'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import { SpawnIntentParam, TerminalColorQueryReplyColorsParam } from './agent-session-params'
import {
  canonicalizeWindowsShellOverride,
  isSupportedWindowsShellOverride,
  listSupportedWindowsShellOverrides
} from '../../shell/launch/windows-terminal-shell'

export * from './terminal-handle-params'

// Refuse at the authoritative host boundary instead of returning an opaque relay spawn failure.
export const WindowsShellOverrideParam = lazyZodSchema(() =>
  z
    .string()
    .refine(isSupportedWindowsShellOverride, {
      message: `shell must be one of: ${listSupportedWindowsShellOverrides().join(', ')}`
    })
    // Canonicalize host-side to the .exe spellings exact-matched by spawn, even if the client did not.
    .transform((shell) => canonicalizeWindowsShellOverride(shell) ?? shell)
)

export const TerminalSetViewerColors = lazyZodSchema(() =>
  z.object({
    colors: TerminalColorQueryReplyColorsParam,
    /** Full appearance for hidden OSC 4/12 and ?996n replies; validated by the host, dropped by older hosts. */
    attributes: z.unknown().optional()
  })
)

/** The provider session a terminal's launch resumes. */
export const ResumeProviderSessionParam = lazyZodSchema(() =>
  z.object({
    key: z.enum(['session_id', 'conversation_id']),
    id: z.string().min(1).max(512),
    transcriptPath: z.string().min(1).max(32_768).optional()
  })
)

export const TerminalCreateParams = lazyZodSchema(() =>
  z.object({
    worktree: OptionalString,
    // Not closed with the worker that created it; older hosts drop it and close none.
    keepOpen: z.literal(true).optional(),
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
    trustWorktreeId: z.string().min(1).max(32_768).optional(),
    launchAgent: z.string().refine(isTuiAgent).optional(),
    terminalKittyKeyboardProtocol: z.boolean().optional(),
    terminalColorQueryReplies: TerminalColorQueryReplyColorsParam.optional(),
    /** The creator's palette and cursor, validated by the host; older hosts drop it. */
    terminalViewAttributes: z.unknown().optional(),
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
)

export const TerminalStop = lazyZodSchema(() =>
  z.object({
    worktree: requiredString('Missing worktree selector')
  })
)

export const TerminalCloseAll = TerminalStop

export const TerminalSleep = TerminalStop

export const TerminalStopExact = lazyZodSchema(() =>
  TerminalStop.extend({
    expectedPtyIds: z.array(requiredString('Missing PTY ID')).min(1),
    keepHistory: z.boolean().optional(),
    targetOnly: z.boolean().optional()
  })
)

export const AgentTeamsTmuxCompat = lazyZodSchema(() =>
  z.object({
    teamId: requiredString('Missing agent team ID'),
    token: requiredString('Missing agent team token'),
    envPane: requiredString('Missing tmux pane identity'),
    cwd: OptionalString,
    argv: z.array(z.string())
  })
)

export const AgentTeamsPrepareLaunch = lazyZodSchema(() =>
  z.object({
    paneKey: requiredString('Missing pane key'),
    env: z.record(z.string(), z.string()).optional(),
    prepareAuth: z.boolean().optional()
  })
)
