import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/manifest/plugin-manifest'

// Why optional: only `approval_required` hands it out; older hosts strip it and older callers omit it.
const approvalFingerprintParam = z.string().min(1).max(128).optional()

export const PluginSetEnabledParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean(),
  approvalFingerprint: approvalFingerprintParam
})

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
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
