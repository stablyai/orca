import { z } from 'zod'
import { TERMINAL_INPUT_MAX_BYTES } from '../../terminal-input'
import type { PluginHookName } from '../contributions/plugin-hook-contribution'
import { PLUGIN_TERMINAL_ID_MAX_LENGTH } from '../workers/plugin-host-api'

/** How long Orca waits on one plugin's hook before it carries on as if the plugin passed. */
export const PLUGIN_HOOK_DEFAULT_DEADLINE_MS = 2_000

const denyResultSchema = z.strictObject({
  /** Why Orca refused; shown to whoever asked for the action. */
  deny: z.string().min(1).max(500)
})

type PluginHookSpec = {
  payload: z.ZodObject
  /** What a handler may return to stop the chain; null when the hook only observes. */
  result: z.ZodType | null
  /** Payload fields `next(event)` may change; any other change is ignored. */
  mutable: readonly string[]
  deadlineMs: number
  summary: string
}

export const terminalSendHookPayloadSchema = z.object({
  /** As `workspace.readContext` and `terminal.sendText` name it. */
  terminalId: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH),
  text: z.string().max(TERMINAL_INPUT_MAX_BYTES),
  /** Whether Enter follows the text. */
  enter: z.boolean(),
  /** `driving`: the CLI or a plugin sending on someone's behalf; `orchestration`: Orca's own
   *  dispatches and relayed messages; `launch`: startup commands and drafts. */
  inputKind: z.enum(['driving', 'orchestration', 'launch'])
})

export const workspaceCreateBeforeHookPayloadSchema = z.object({
  kind: z.enum(['worktree', 'folder']),
  /** The project the workspace is created in. */
  projectId: z.string().min(1).max(2048),
  name: z.string().min(1).max(1024),
  /** Branch to create or open; absent when Orca derives it from `name`. Worktrees only. */
  branch: z.string().min(1).max(1024).optional(),
  /** Ref the new branch starts from; absent for the project's default. Worktrees only. */
  base: z.string().min(1).max(1024).optional()
})

export const workspaceCreateAfterHookPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(2048),
  kind: z.enum(['worktree', 'folder']),
  path: z
    .string()
    .min(1)
    .max(32 * 1024),
  /** Empty for folder workspaces. */
  branch: z.string().max(1024)
})

export const PLUGIN_HOOK_SPECS = {
  'terminal.send': {
    payload: terminalSendHookPayloadSchema,
    result: denyResultSchema,
    mutable: ['text', 'enter'],
    deadlineMs: PLUGIN_HOOK_DEFAULT_DEADLINE_MS,
    summary:
      'Text Orca, the CLI or a plugin is about to send to a terminal. A person typing (on the desktop, a phone or a paired client) is never hooked, and prompts Orca submits to an agent are not included (a separate agent prompt hook covers them). Writes to one terminal stay in order while a hook decides. Rewrite `text` or `enter` with `next`, or return `{ deny }` to refuse the send.'
  },
  'workspace.create.before': {
    payload: workspaceCreateBeforeHookPayloadSchema,
    result: denyResultSchema,
    mutable: ['name', 'branch', 'base'],
    deadlineMs: PLUGIN_HOOK_DEFAULT_DEADLINE_MS,
    summary:
      'A worktree or folder workspace is about to be created. Change `name`, `branch` or `base` with `next`, or return `{ deny }` to refuse it.'
  },
  'workspace.create.after': {
    payload: workspaceCreateAfterHookPayloadSchema,
    result: null,
    mutable: [],
    deadlineMs: PLUGIN_HOOK_DEFAULT_DEADLINE_MS,
    summary:
      'A worktree or folder workspace was created. Observe only: Orca does not wait for it, and results are ignored.'
  }
} satisfies Record<PluginHookName, PluginHookSpec>

export type PluginHookPayload<H extends PluginHookName> = z.infer<
  (typeof PLUGIN_HOOK_SPECS)[H]['payload']
>

export type PluginHookDenyResult = z.infer<typeof denyResultSchema>
