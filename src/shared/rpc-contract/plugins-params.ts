import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/manifest/plugin-manifest'

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
  ifShown: z.boolean().optional()
})
