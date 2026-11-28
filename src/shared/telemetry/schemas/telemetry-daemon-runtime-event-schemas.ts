import { z } from 'zod'
import { AGENT_HOOK_TARGETS } from '../../agent-hook-listener/configuration/agent-hook-types'
import { ERRNO_CODE_PATTERN } from '../../errors/errno-code'
import { errorClassSchema, settingsChangedKeySchema } from './telemetry-property-schemas'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Enum-only start-failure signals diagnose fleet outages without sending raw stderr (v1.4.129-rc.1).
export const daemonStartFailedSchema = lazyZodSchema(() =>
  z.object({ error_class: errorClassSchema }).strict()
)

export const runtimeRpcStartErrorClassSchema = lazyZodSchema(() =>
  z.enum(['permission_denied', 'address_in_use', 'storage_unavailable', 'invalid_path', 'unknown'])
)
export type RuntimeRpcStartErrorClass = z.infer<typeof runtimeRpcStartErrorClassSchema>

// Discovery errors may contain user paths; send only closed filesystem/socket categories.
export const runtimeRpcStartFailedSchema = lazyZodSchema(() =>
  z.object({ error_class: runtimeRpcStartErrorClassSchema }).strict()
)

// Why: classify session-killing 1013 closures as producer size failures or queue backpressure.
export const remoteOutboundBudgetCloseSchema = lazyZodSchema(() =>
  z
    .object({
      emitter: z.enum(['size', 'queue']),
      // Which limit fired, and the RPC method that queued the most since the socket's backlog began.
      cap: z
        .enum([
          'maxQueuedBytes',
          'maxQueuedFrames',
          'maxFrameBytes',
          'claimQueuedBytes',
          'sendFailed',
          'bufferedBytes',
          'socketSources'
        ])
        .optional(),
      top_method: z
        .string()
        .max(80)
        .regex(/^[A-Za-z][\w.]*$/)
        .optional()
    })
    .strict()
)

// Main deadlocks yield no crash report. self_recovered separates stalls that resolved from those a recovery kill might help;
// keep observed unresponsive_ms raw to calibrate the 45s threshold without assuming every stall needs termination.
export const mainThreadHangDetectedSchema = lazyZodSchema(() =>
  z
    .object({
      unresponsive_ms: z.number().int().nonnegative(),
      self_recovered: z.boolean(),
      native_top_frames: z.array(z.string().max(180)).max(24).optional(),
      macos_build: z
        .string()
        .max(64)
        .regex(/^macOS \d+(?:\.\d+){0,3} \([A-Za-z0-9]+\)$/)
        .optional(),
      menu_bar_icon: z.boolean().nullable().optional(),
      // The launch that reports a hang may run another version than the one that hung.
      detected_app_version: z.string().max(64).optional()
    })
    .strict()
)

// Measure Codex app-server trust grants instead of computed trusted_hash: fallback/verify_failed detect rollout failures.
// Omit steady ledger skips (launch volume only); lane separates real/managed homes and closed error/verify classes explain failures without raw errors.
export const codexTrustGrantSchema = lazyZodSchema(() =>
  z
    .object({
      outcome: z.enum(['granted', 'fallback', 'verify_failed']),
      host_kind: z.enum(['native', 'wsl']),
      lane: z.enum(['real-home', 'managed']),
      fallback_reason: z
        .enum([
          'disabled',
          'no-managed-entries',
          'unsupported',
          'unsupported-cached',
          'verify-failed',
          'retry-cached',
          'error'
        ])
        .optional(),
      error_class: z
        .enum([
          'binary-missing',
          'timeout',
          'entry-failed',
          'early-exit',
          'rpc-failed',
          'unexpected'
        ])
        .optional(),
      verify_class: z
        .enum([
          'list-mismatch',
          'post-grant-untrusted',
          'post-grant-mismatch',
          'unexpected-key',
          'duplicate-key',
          'coverage'
        ])
        .optional()
    })
    .strict()
)

export const settingsChangedSchema = lazyZodSchema(() =>
  z
    .object({
      setting_key: settingsChangedKeySchema,
      value_kind: z.enum(['bool', 'enum'])
    })
    .strict()
)

// Verify profile authority/migration rollout with enums only; never send paths, profile IDs or serialized state.
export const profileStateAuthoritySelectedSchema = lazyZodSchema(() =>
  z
    .object({
      backend: z.enum(['json', 'sqlite']),
      classification: z.enum(['neither', 'json-only', 'sqlite-only', 'both']),
      authority_mode: z.enum(['legacy', 'sqlite-candidate', 'sqlite-established']),
      runtime: z.enum(['desktop', 'orcad']),
      migrated: z.boolean()
    })
    .strict()
)

// Managed-hook installer label from `AGENT_HOOK_TARGETS`, distinct from `AGENT_KIND_VALUES`; `claude` (not `claude-code`) is intentional.
export const hookInstallAgentSchema = lazyZodSchema(() => z.enum(AGENT_HOOK_TARGETS))
export type HookInstallAgent = z.infer<typeof hookInstallAgentSchema>

// Why (#21492): field name kept for dashboards, but it holds an errno code or 'unknown', never the raw message (home-dir paths).
export const agentHookInstallFailedSchema = lazyZodSchema(() =>
  z
    .object({
      agent: hookInstallAgentSchema,
      error_message: z.union([z.literal('unknown'), z.string().regex(ERRNO_CODE_PATTERN)])
    })
    .strict()
)

// Measure paneKey routing failures; see docs/cli-terminal-hook-pane-key.md.
export const agentHookUnattributedSchema = lazyZodSchema(() =>
  z.object({ reason: z.enum(['empty_pane_key', 'unknown_tab_id']) }).strict()
)

// Security software resetting loopback hook bodies can kill all runtime status (#11217). Count only;
// truncated bodies contain prompts/tool I/O, so send nothing derived from them.
export const agentHookTransportBlockedSchema = lazyZodSchema(() =>
  z.object({ count: z.number().int().nonnegative() }).strict()
)
