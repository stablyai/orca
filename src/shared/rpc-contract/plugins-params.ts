import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/manifest/plugin-manifest'
import {
  PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS,
  pluginBridgeNameSchema,
  pluginPanelCallerSchema
} from '../plugins/workers/plugin-panel-bridge-protocol'
import { pluginShotActsSchema } from '../plugins/view/plugin-shot-acts'
import { PLUGIN_DECLARATIVE_RENDER_LANE } from '../plugins/declarative/plugin-declarative-limits'

// Why optional: only `approval_required` hands it out; older hosts strip it and older callers omit it.
const approvalFingerprintParam = z.string().min(1).max(128).optional()

export const PluginSetEnabledParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean(),
  approvalFingerprint: approvalFingerprintParam
})

export const PluginSetSystemEnabledParams = z.object({ enabled: z.boolean() })

/** Over RPC, approval needs the explicit CLI fingerprint; the desktop review dialog uses IPC. */
export const PluginRpcConsentParams = z
  .object({
    pluginKey: z.string().min(1),
    reviewedFingerprint: z.string().min(1).max(256).optional(),
    decision: z.enum(['approve', 'keep-disabled']),
    approvalFingerprint: approvalFingerprintParam
  })
  .strip()

export const PluginReadPanelEntryParams = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1)
})

export const PluginInvokeCommandParams = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const PluginsPanelActionParams = z.unknown()

// Why 32 KiB: the same bound settings keep for each development folder entry.
const devFolderPathParam = z
  .string()
  .min(1)
  .max(32 * 1024)

export const PluginDevLoadParams = z.object({
  path: devFolderPathParam,
  approvalFingerprint: approvalFingerprintParam
})

export const PluginDevUnloadParams = z
  .object({
    path: devFolderPathParam.optional(),
    pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key').optional()
  })
  .refine((params) => (params.path === undefined) !== (params.pluginKey === undefined), {
    message: 'pass exactly one of path or pluginKey'
  })

/** `orca plugin dev emit`: the host checks `event` against its own event list so older names get a clear refusal. */
export const PluginDevEmitParams = z
  .object({
    path: devFolderPathParam.optional(),
    pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key').optional(),
    event: z.string().min(1).max(128),
    payload: z.unknown().optional()
  })
  .refine((params) => (params.path === undefined) !== (params.pluginKey === undefined), {
    message: 'pass exactly one of path or pluginKey'
  })

/** `orca plugin dev request`: one `plugin.request` to a development plugin's worker. */
export const PluginDevRequestParams = z
  .object({
    path: devFolderPathParam.optional(),
    pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key').optional(),
    name: pluginBridgeNameSchema,
    input: z.json().optional(),
    /** The caller panel id the handler sees, so a test can target `orca.panels.post`. */
    panel: pluginPanelCallerSchema.shape.id.optional(),
    timeoutMs: z.number().int().min(1).max(PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS).optional()
  })
  .refine((params) => (params.path === undefined) !== (params.pluginKey === undefined), {
    message: 'pass exactly one of path or pluginKey'
  })

export const PluginGetLogsParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  /** `cursor` from an earlier reply; only later lines come back. Older hosts ignore it. */
  after: z.string().max(64).optional()
})

export const PluginDevInspectParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export const PluginRestartParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

const pluginKeyParam = z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
const contributionIdParam = z.string().min(1).max(128)

/** `orca plugin open`: a panel (default: the first) or, with `filePath`, a file in its editor. */
export const PluginOpenParams = z
  .object({
    pluginKey: pluginKeyParam,
    panelId: contributionIdParam.optional(),
    /** Absolute path on the host. */
    filePath: devFolderPathParam.optional()
  })
  .refine((params) => params.panelId === undefined || params.filePath === undefined, {
    message: 'pass at most one of panelId or filePath'
  })

export const PLUGIN_SHOT_MIN_WIDTH = 160
export const PLUGIN_SHOT_MAX_WIDTH = 4000

export const PluginShotParams = z.object({
  pluginKey: pluginKeyParam,
  panelId: contributionIdParam.optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
  width: z.number().int().min(PLUGIN_SHOT_MIN_WIDTH).max(PLUGIN_SHOT_MAX_WIDTH).optional(),
  /** Capture only while the panel is the open right-sidebar tab; never open or switch to it. */
  ifShown: z.boolean().optional(),
  /** Input to run on a components panel before the capture; older hosts strip it. */
  acts: pluginShotActsSchema.optional()
})

// Why the render lane's cap: the same bytes a live panel may send Orca for one tree.
export const PLUGIN_SHOT_REPLAY_MAX_TREE_BYTES = PLUGIN_DECLARATIVE_RENDER_LANE.maxBytes

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** `orca plugin shot --scenario`: a tree the CLI rendered locally, drawn detached from the plugin.
 *  Its own method so an older host fails `method_not_found` instead of shooting the live panel. */
export const PluginShotReplayParams = z.object({
  pluginKey: pluginKeyParam,
  panelId: contributionIdParam,
  title: z.string().min(1).max(256).optional(),
  scenario: z.string().min(1).max(128),
  /** Re-validated in main with the declarative tree parser. */
  tree: z
    .unknown()
    .refine(
      (tree) => jsonBytes(tree) <= PLUGIN_SHOT_REPLAY_MAX_TREE_BYTES,
      `tree is over ${PLUGIN_SHOT_REPLAY_MAX_TREE_BYTES / 1024} KiB`
    ),
  colorScheme: z.enum(['light', 'dark']).optional(),
  width: z.number().int().min(PLUGIN_SHOT_MIN_WIDTH).max(PLUGIN_SHOT_MAX_WIDTH).optional()
})
