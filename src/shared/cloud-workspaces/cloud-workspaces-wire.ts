// Team workspace registry wire types (sandbox control plane /v1/team/workspaces, /v1/links, /v1/team/prompts).
// Mirrors cloud/apps/sandbox-control/src/workspaces.ts, grants.ts and org-prompts.ts.
import { z } from 'zod'

const Id = z.string().min(1).max(128)

export const CloudWorkspacePresenceSchema = z.object({
  userId: Id,
  clientId: Id,
  state: z.enum(['viewing', 'typing']),
  chatId: Id.nullable(),
  at: z.number()
})

export const CloudWorkspaceCostSchema = z.object({
  computeMs: z.number().min(0),
  rateUsdMicrosPerHour: z.number().min(0),
  computeUsdMicros: z.number().min(0),
  tokenUsdMicros: z.number().min(0).nullable(),
  totalUsdMicros: z.number().min(0)
})

export const CloudWorkspaceSchema = z.object({
  id: Id,
  workspaceId: Id,
  status: z.enum([
    'creating',
    'running',
    'suspending',
    'suspended',
    'resuming',
    'destroying',
    'destroyed',
    'failed'
  ]),
  machineSize: z.enum(['standard', 'large']),
  region: z.string(),
  createdAt: z.number(),
  title: z.string().nullable(),
  // Its number in the account, shown as W-123 (formatWorkspaceNumber). Older control planes omit it.
  number: z.number().int().positive().nullable().optional().catch(undefined),
  // The link to copy (org slug + number, or the sandbox id form). Older control planes omit it.
  link: z.string().max(512).optional().catch(undefined),
  repo: z.object({ url: z.string(), branch: z.string().nullable() }).nullable(),
  visibility: z.enum(['private', 'team']),
  section: z.string().nullable(),
  archivedAt: z.number().nullable(),
  createdBy: Id,
  ownerUserId: Id,
  lastActivityAt: z.number(),
  lastActivityBy: Id.nullable(),
  cost: CloudWorkspaceCostSchema,
  access: z.enum(['owner', 'granted', 'can_open', 'none']),
  presence: z.array(CloudWorkspacePresenceSchema),
  // Display names (each member's token `name` claim) for the ids above. Labels only, and the org
  // roster wins where it has an entry. Older control planes omit it.
  memberNames: z.record(z.string(), z.string().max(80)).optional().catch(undefined),
  // When the last sleeping read snapshot was stored (ms), present only when the caller can open the
  // workspace; drives "As of" in lists without fetching the blob. Older control planes omit it.
  readSnapshotAt: z.number().nullable().optional().catch(undefined),
  // Started by a routine run. Home lists these only with its Routine runs filter on (routines=include).
  // Older control planes omit it.
  fromRoutine: z.boolean().optional().catch(undefined),
  // The routine that started it, for routine runs (shown as "Routine · <name>").
  routineName: z.string().max(200).nullable().optional().catch(undefined),
  // Who follows it (oldest first) and whether the caller does (PARITY-FOLLOW). Older control planes
  // omit them.
  followers: z.array(Id).max(500).optional().catch(undefined),
  following: z.boolean().optional().catch(undefined)
})

export type CloudWorkspace = z.infer<typeof CloudWorkspaceSchema>
export type CloudWorkspacePresence = z.infer<typeof CloudWorkspacePresenceSchema>

/** What Home's Routine runs switch hides (counts and hours stay in the team's totals). */
export const CloudWorkspaceRoutineRunsSchema = z.object({
  /** Routines the team has: the switch is offered only when there is at least one. */
  routines: z.number().int().min(0),
  hidden: z.number().int().min(0),
  hiddenRunning: z.number().int().min(0),
  hiddenComputeMs: z.number().min(0)
})
export type CloudWorkspaceRoutineRuns = z.infer<typeof CloudWorkspaceRoutineRunsSchema>

export const CloudWorkspaceListResponseSchema = z.object({
  workspaces: z.array(CloudWorkspaceSchema),
  // Older control planes omit it.
  routineRuns: CloudWorkspaceRoutineRunsSchema.optional().catch(undefined)
})
export const CloudWorkspaceResponseSchema = z.object({ workspace: CloudWorkspaceSchema })
/** PUT/DELETE /v1/team/workspaces/:id/follow (PARITY-FOLLOW). */
export const CloudWorkspaceFollowSchema = z.object({
  following: z.boolean(),
  followers: z.array(Id)
})
export type CloudWorkspaceFollow = z.infer<typeof CloudWorkspaceFollowSchema>
export const CloudWorkspacePresenceResponseSchema = z.object({
  presence: z.array(CloudWorkspacePresenceSchema)
})
export const CloudWorkspaceLinkResponseSchema = z.object({
  workspace: CloudWorkspaceSchema,
  chatId: Id.nullable()
})

export const CloudWorkspaceGrantSchema = z.object({
  id: Id,
  workspaceId: Id,
  userId: Id,
  deviceKind: z.enum(['desktop', 'mobile']),
  deviceLabel: z.string(),
  status: z.enum(['issuing', 'active', 'revoking', 'revoked', 'failed']),
  createdAt: z.number(),
  revokedAt: z.number().nullable()
})
export type CloudWorkspaceGrant = z.infer<typeof CloudWorkspaceGrantSchema>

export const SealedGrantSchema = z.object({
  v: z.literal(1),
  ephemeralPublicKeyB64: z.string(),
  nonceB64: z.string(),
  ciphertextB64: z.string()
})
export const CloudWorkspaceGrantIssuedSchema = z.object({
  grant: CloudWorkspaceGrantSchema,
  sealed: SealedGrantSchema
})
export const CloudWorkspaceGrantListSchema = z.object({
  grants: z.array(CloudWorkspaceGrantSchema)
})

// Reader keys: this device's long-lived X25519 key that sleeping workspaces seal their read snapshot to.
export const CloudReaderKeySchema = z.object({
  id: z.string().regex(/^rk_[0-9a-f]{24}$/),
  deviceKind: z.enum(['desktop', 'mobile']),
  deviceLabel: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number()
})
export type CloudReaderKeyRegistration = z.infer<typeof CloudReaderKeySchema>
export const CloudReaderKeyResponseSchema = z.object({ readerKey: CloudReaderKeySchema })

/** Mirrors SealedReadSnapshot in read-snapshot.ts (the opener re-checks every length). */
export const SealedReadSnapshotSchema = z.object({
  v: z.literal(1),
  snapshotId: Id,
  workspaceId: Id,
  storedAt: z.number(),
  nonceB64: z.string().max(64),
  ciphertextB64: z.string().max(16 * 1024 * 1024),
  recipient: z.object({
    keyId: Id,
    ephemeralPublicKeyB64: z.string().max(64),
    nonceB64: z.string().max(64),
    wrappedKeyB64: z.string().max(128)
  }),
  // The VM's Ed25519 signature (read-snapshot-signature.ts); absent from VMs before signing.
  signature: z
    .object({ publicKeyB64: z.string().max(64), signatureB64: z.string().max(128) })
    .optional()
})
export const CloudReadSnapshotResponseSchema = z.object({ snapshot: SealedReadSnapshotSchema })

export type CloudWorkspaceListQuery = {
  scope?: 'mine' | 'team' | 'all'
  by?: string
  repo?: string
  section?: string
  archived?: 'exclude' | 'include' | 'only'
  /** Routine runs are left out unless `include` (older control planes ignore it and leave them out). */
  routines?: 'exclude' | 'include'
}

export type CloudWorkspacePatch = {
  title?: string | null
  branch?: string | null
  visibility?: 'private' | 'team'
  section?: string | null
  archived?: boolean
  ownerUserId?: string
  tokenUsdMicros?: number
}

export const OrgPromptsSchema = z.object({
  document: z.object({
    prompts: z.array(z.object({ id: z.string(), name: z.string(), body: z.string() })),
    prInstructions: z.string()
  }),
  revision: z.number(),
  updatedAt: z.number().nullable(),
  updatedBy: z.string().nullable()
})
export type OrgPrompts = z.infer<typeof OrgPromptsSchema>

/** W-123: how a workspace's number reads everywhere (list, top bar, palette, links). */
export function formatWorkspaceNumber(n: number): string {
  return `W-${n}`
}

/** "W-123", "w123", "#123" or "123" → 123; anything else is null (palette search, pasted ids). */
export function parseWorkspaceNumber(text: string): number | null {
  const match = /^\s*(?:w-?|#)?(\d{1,9})\s*$/i.exec(text)
  const n = match ? Number(match[1]) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

// Synced sidebar arrangement (/v1/team/prefs; mirrors sandbox-control src/workspace-prefs.ts).
const SandboxId = z.string().regex(/^sbx_[0-9a-f]{24}$/)
const SectionName = z.string().min(1).max(64)
export const CloudWorkspacePrefsDocumentSchema = z.object({
  pinned: z.array(SandboxId).max(200),
  order: z.array(SandboxId).max(500),
  sections: z.array(SectionName).max(50),
  collapsed: z.array(SectionName).max(50)
})
export type CloudWorkspacePrefsDocument = z.infer<typeof CloudWorkspacePrefsDocumentSchema>
export const CloudWorkspacePrefsSchema = z.object({
  document: CloudWorkspacePrefsDocumentSchema,
  revision: z.number().int().min(0),
  updatedAt: z.number().nullable()
})
export type CloudWorkspacePrefs = z.infer<typeof CloudWorkspacePrefsSchema>
export const EMPTY_CLOUD_WORKSPACE_PREFS: CloudWorkspacePrefsDocument = {
  pinned: [],
  order: [],
  sections: [],
  collapsed: []
}

/** /v1/team/org: the org's URL slug for links (null for personal accounts or before it is named). */
export const CloudOrgSlugSchema = z.object({
  slug: z.string().nullable(),
  orgId: z.string().nullable()
})
export type CloudOrgSlug = z.infer<typeof CloudOrgSlugSchema>

/** What a link names: a sandbox id (orca://cloud/w/<id>) or an org slug and number (orca://cloud/<slug>/W-<n>). */
export type CloudWorkspaceLinkTarget =
  | { kind: 'id'; workspaceId: string }
  | { kind: 'number'; org: string; number: number }

/**
 * Deep links (desktop and mobile):
 *   orca://cloud/w/<sandboxId>[/c/<chatId>]       works for any account
 *   orca://cloud/<org-slug>/W-<n>[/c/<chatId>]    what Copy link gives in a team
 */
const ID_LINK = /^orca:\/\/cloud\/w\/(sbx_[0-9a-f]{24})(?:\/c\/([A-Za-z0-9_.:%-]{1,256}))?\/?$/
const NUMBER_LINK =
  /^orca:\/\/cloud\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\/[Ww]-(\d{1,9})(?:\/c\/([A-Za-z0-9_.:%-]{1,256}))?\/?$/

export function cloudWorkspaceLink(id: string, chatId?: string | null): string {
  return `orca://cloud/w/${id}${chatId ? `/c/${encodeURIComponent(chatId)}` : ''}`
}

/** The server's link for a workspace (slug form when it has one), with a chat appended. */
export function cloudWorkspaceShareLink(
  workspace: { id: string; link?: string },
  chatId?: string | null
): string {
  const base = workspace.link && parseCloudWorkspaceLink(workspace.link) ? workspace.link : null
  if (!base) {
    return cloudWorkspaceLink(workspace.id, chatId)
  }
  return `${base.replace(/\/$/, '')}${chatId ? `/c/${encodeURIComponent(chatId)}` : ''}`
}

function decodeChat(raw: string | undefined): string | null | undefined {
  if (!raw) {
    return null
  }
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

export function parseCloudWorkspaceLink(
  url: string
): { target: CloudWorkspaceLinkTarget; chatId: string | null } | null {
  const text = url.trim()
  const byId = ID_LINK.exec(text)
  if (byId) {
    const chatId = decodeChat(byId[2])
    return chatId === undefined ? null : { target: { kind: 'id', workspaceId: byId[1]! }, chatId }
  }
  const byNumber = NUMBER_LINK.exec(text)
  if (!byNumber || byNumber[1]!.includes('--')) {
    return null
  }
  const number = Number(byNumber[2])
  const chatId = decodeChat(byNumber[3])
  if (!Number.isSafeInteger(number) || number < 1 || chatId === undefined) {
    return null
  }
  return { target: { kind: 'number', org: byNumber[1]!, number }, chatId }
}
