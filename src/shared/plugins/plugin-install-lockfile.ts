import { z } from 'zod'
import { isQualifiedPluginKey } from './plugin-manifest'

/**
 * Install lockfile: records where each installed plugin came from, the exact
 * commit it resolved to, the content hash of the installed tree, and the
 * consent fingerprint the user was shown. A reinstall/update that does not
 * match is a visible change, never a silent one. Adapted from community PR
 * #5801's SHA-256 + lockfile installer pieces.
 */

/** Install content hash: legacy 128-bit SHA-256 prefix or the full digest. */
export const PLUGIN_CONTENT_HASH_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/
/** Git object id, SHA-1 or SHA-256. */
export const PLUGIN_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export const pluginInstallSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local-path'),
    path: z
      .string()
      .min(1)
      .max(32 * 1024)
  }),
  z.object({
    kind: z.literal('git'),
    url: z
      .string()
      .min(1)
      .max(32 * 1024)
      .refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
    /** Requested ref (`#ref` suffix); empty means the remote default branch. */
    ref: z.string().max(4096).default('')
  }),
  z.object({
    kind: z.literal('marketplace'),
    marketplace: z.object({
      url: z
        .string()
        .min(1)
        .max(32 * 1024)
        .refine(isAllowedPluginGitUrl, 'marketplace Git URL must use HTTPS or SSH'),
      ref: z.string().min(1).max(4096),
      resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN)
    }),
    plugin: z.object({
      url: z
        .string()
        .min(1)
        .max(32 * 1024)
        .refine(isAllowedPluginGitUrl, 'plugin Git URL must use HTTPS or SSH'),
      ref: z.string().min(1).max(4096)
    })
  }),
  z.object({
    kind: z.literal('bundled'),
    bundleId: z.string().refine(isQualifiedPluginKey, 'invalid bundled plugin identity')
  })
])

export type PluginInstallSource = z.infer<typeof pluginInstallSourceSchema>

/** System Git supports executable remote helpers (`ext::`, custom `foo::`
 * transports). P0 accepts network Git only over HTTPS or SSH so installing a
 * source cannot turn URL parsing into arbitrary command execution. */
export function isAllowedPluginGitUrl(value: string): boolean {
  const url = value.trim()
  if (/^[^\s@/:]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) {
    return true
  }
  try {
    const parsed = new URL(url)
    if (!parsed.hostname || parsed.password) {
      return false
    }
    if (parsed.protocol === 'https:') {
      return parsed.username.length === 0
    }
    return parsed.protocol === 'ssh:'
  } catch {
    return false
  }
}

export const pluginLockEntrySchema = z
  .object({
    /** Qualified `<publisher>.<id>` key. */
    pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
    version: z.string().min(1).max(128),
    source: pluginInstallSourceSchema,
    /** Commit the git source resolved to at install time; null for local. */
    resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN).nullable(),
    /** Deterministic hash of the installed file tree (also the install dir name). */
    contentHash: z.string().regex(PLUGIN_CONTENT_HASH_PATTERN),
    /** New descriptive name, accepted for forward compatibility. */
    consentFingerprint: z.string().min(1).max(256).optional(),
    /** v1 on-disk name retained so existing Orca builds can read new lockfiles. */
    capabilityHash: z.string().min(1).max(256).optional(),
    installedAt: z.number().finite().nonnegative()
  })
  .refine((entry) => entry.consentFingerprint || entry.capabilityHash, {
    message: 'consent fingerprint is required'
  })
  .transform(({ capabilityHash, consentFingerprint, ...entry }) => ({
    ...entry,
    consentFingerprint: consentFingerprint ?? capabilityHash!
  }))

export type PluginLockEntry = z.infer<typeof pluginLockEntrySchema>

export const pluginLockfileSchema = z
  .object({
    version: z.literal(1),
    plugins: z.record(z.string(), pluginLockEntrySchema)
  })
  .superRefine((lock, ctx) => {
    for (const [key, entry] of Object.entries(lock.plugins)) {
      if (!isQualifiedPluginKey(key) || entry.pluginKey !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plugins', key],
          message: 'lockfile key must match its qualified plugin identity'
        })
      }
    }
  })

export type PluginLockfile = z.infer<typeof pluginLockfileSchema>

/**
 * Lockfile v1 called this opaque value `capabilityHash`. Keep writing that
 * field so rollback to an older host does not make the whole lockfile unreadable.
 */
export function serializePluginLockfile(lock: PluginLockfile): unknown {
  return {
    version: 1,
    plugins: Object.fromEntries(
      Object.entries(lock.plugins).map(([key, { consentFingerprint, ...entry }]) => [
        key,
        { ...entry, capabilityHash: consentFingerprint }
      ])
    )
  }
}

export function emptyPluginLockfile(): PluginLockfile {
  return { version: 1, plugins: {} }
}

export function upsertPluginLock(lock: PluginLockfile, entry: PluginLockEntry): PluginLockfile {
  return { version: 1, plugins: { ...lock.plugins, [entry.pluginKey]: entry } }
}

export function removePluginLock(lock: PluginLockfile, pluginKey: string): PluginLockfile {
  const plugins = { ...lock.plugins }
  delete plugins[pluginKey]
  return { version: 1, plugins }
}

export function parsePluginLockfile(raw: unknown): PluginLockfile {
  const parsed = pluginLockfileSchema.safeParse(raw)
  // A corrupt lockfile must not brick installs; integrity of installed trees
  // is independently anchored by their hash-addressed directory names.
  return parsed.success ? parsed.data : emptyPluginLockfile()
}
