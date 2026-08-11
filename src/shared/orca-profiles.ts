import { ORCA_BROWSER_PARTITION } from './constants'
import type { ExecutionHostId } from './execution-host'

export const ORCA_PROFILE_INDEX_SCHEMA_VERSION = 1
export const DEFAULT_LOCAL_ORCA_PROFILE_ID = 'local-default'
export const DEFAULT_LOCAL_ORCA_PROFILE_NAME = 'Personal'
const LEGACY_ORCA_BROWSER_SESSION_PARTITION_PREFIX = 'persist:orca-browser-session-'

export type OrcaProfileAvatar = {
  kind: 'initials'
  initials: string
  color: 'neutral'
}

export type OrcaProfileKind = 'local' | 'cloud-linked'

export type OrcaProfileCloudSummary = {
  cloudProfileId: string
  userId: string
  email: string
  displayName?: string
  activeOrgId?: string
  activeOrgName?: string
  linkedAt: number
}

export type OrcaCloudOrgSummary = {
  orgId: string
  name: string
  role?: string
}

export type OrcaCloudCapabilityFlags = Record<string, boolean>

export type OrcaCloudCapabilities = {
  flags: OrcaCloudCapabilityFlags
  refreshedAt: number
}

export type OrcaCloudSessionPersistence = 'none' | 'encrypted' | 'memory-only' | 'dev-plaintext'

export type OrcaProfileAuthState = 'local' | 'unconfigured' | 'connected' | 'reconnect-required'

export type OrcaProfileAuthStatus = {
  activeProfileId: string
  configured: boolean
  state: OrcaProfileAuthState
  persistence: OrcaCloudSessionPersistence
  cloud?: OrcaProfileCloudSummary
  organizations?: OrcaCloudOrgSummary[]
  capabilities?: OrcaCloudCapabilities
  credentialError?: string
  setupMessage?: string
}

export type OrcaProfileSummary = {
  id: string
  name: string
  avatar: OrcaProfileAvatar
  kind: OrcaProfileKind
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  cloud?: OrcaProfileCloudSummary
}

export type OrcaProfileIndex = {
  schemaVersion: number
  activeProfileId: string
  profiles: OrcaProfileSummary[]
}

export type OrcaProfileListState = {
  activeProfileId: string
  profiles: OrcaProfileSummary[]
}

export type OrcaProfileListResult = OrcaProfileListState & {
  // Why: gates the full multi-profile switcher UI; default builds show a
  // single-profile account menu instead.
  multiProfileUi: boolean
}

export type CreateLocalOrcaProfileArgs = {
  name?: string
}

export type CreateLocalOrcaProfileResult = OrcaProfileListState & {
  profile: OrcaProfileSummary
}

export type CreateCloudLinkedOrcaProfileArgs = {
  orgId?: string
  name?: string
}

export type SwitchOrcaProfileArgs = {
  profileId: string
}

export type SwitchOrcaProfileResult = {
  status: 'already-active' | 'relaunching'
}

export type TransferOrcaProfileProjectMode = 'move' | 'copy'

export type TransferOrcaProfileProjectArgs = {
  sourceProfileId: string
  targetProfileId: string
  repoId: string
  mode: TransferOrcaProfileProjectMode
}

export type FindOrcaProfileProjectsByPathArgs = {
  path: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  excludeProfileId?: string | null
}

export type OrcaProfileProjectPresence = {
  profileId: string
  profileName: string
  profileKind: OrcaProfileKind
  repoId: string
  repoName: string
}

export type FindOrcaProfileProjectsByPathResult = {
  projects: OrcaProfileProjectPresence[]
}

export type TransferOrcaProfileProjectResult =
  | {
      status: 'transferred'
      mode: TransferOrcaProfileProjectMode
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      targetRepoId: string
      targetProjectId: string | null
      willRelaunch?: boolean
    }
  | {
      status: 'duplicate-target'
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      duplicateRepoId: string
    }

export type ConnectCurrentOrcaProfileResult =
  | {
      status: 'connected'
      auth: OrcaProfileAuthStatus
      activeProfileId: string
      profiles: OrcaProfileSummary[]
    }
  | {
      status: 'unconfigured'
      auth: OrcaProfileAuthStatus
    }
  | {
      status: 'cancelled'
      auth: OrcaProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: OrcaProfileAuthStatus
      error: string
    }

export type CreateCloudLinkedOrcaProfileResult =
  | {
      status: 'created'
      auth: OrcaProfileAuthStatus
      activeProfileId: string
      profiles: OrcaProfileSummary[]
      profile: OrcaProfileSummary
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: OrcaProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: OrcaProfileAuthStatus
      error: string
    }

export type SignOutCurrentOrcaProfileResult = {
  status: 'signed-out'
  auth: OrcaProfileAuthStatus
  activeProfileId: string
  profiles: OrcaProfileSummary[]
}

export type SelectOrcaProfileOrgArgs = {
  orgId: string
}

export type SelectOrcaProfileOrgResult =
  | {
      status: 'selected'
      auth: OrcaProfileAuthStatus
      activeProfileId: string
      profiles: OrcaProfileSummary[]
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: OrcaProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: OrcaProfileAuthStatus
      error: string
    }

export type RefreshCurrentOrcaProfileAuthResult =
  | {
      status: 'refreshed'
      auth: OrcaProfileAuthStatus
      activeProfileId: string
      profiles: OrcaProfileSummary[]
    }
  | {
      status: 'local' | 'unconfigured' | 'reconnect-required'
      auth: OrcaProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: OrcaProfileAuthStatus
      error: string
    }

// Why: organization roles are a fixed server-side enum; the desktop UI mirrors
// exactly these three so role selects can't drift from what the API accepts.
export type OrcaOrgRole = 'owner' | 'admin' | 'member'

export type OrcaOrgMember = {
  // Why: null for teammates provisioned server-side who never signed into Orca;
  // mutation actions are disabled for them since the API keys on a real userId.
  userId: string | null
  email: string
  displayName?: string
  role: OrcaOrgRole
}

export type OrcaOrgPendingInvite = {
  email: string
  role: OrcaOrgRole
  createdAt: number
}

export type OrcaOrgMembersRoster = {
  members: OrcaOrgMember[]
  pendingInvites: OrcaOrgPendingInvite[]
  viewerRole: OrcaOrgRole
  canManageMembers: boolean
}

export type OrcaProfileOrgMembersListArgs = {
  orgId: string
}

export type OrcaProfileOrgMemberInviteArgs = {
  orgId: string
  email: string
  role: OrcaOrgRole
}

export type OrcaProfileOrgInviteRevokeArgs = {
  orgId: string
  email: string
}

export type OrcaProfileOrgMemberChangeRoleArgs = {
  orgId: string
  userId: string
  role: OrcaOrgRole
}

export type OrcaProfileOrgMemberRemoveArgs = {
  orgId: string
  userId: string
}

export type OrcaProfileOrgMembersListResult =
  | { status: 'ok'; roster: OrcaOrgMembersRoster }
  | { status: 'unconfigured' | 'reconnect-required' }
  | { status: 'failed'; error: string }

export type OrcaOrgInviteConflictReason = 'already_member' | 'already_invited'
export type OrcaOrgMutationInvalidReason = 'cannot_change_own_role' | 'cannot_remove_self'

export type OrcaProfileOrgMemberMutationResult =
  | { status: 'ok' }
  | { status: 'unconfigured' | 'reconnect-required' | 'forbidden' | 'not-found' }
  | { status: 'conflict'; reason: OrcaOrgInviteConflictReason }
  | { status: 'invalid'; reason: OrcaOrgMutationInvalidReason }
  | { status: 'failed'; error: string }

export function createDefaultLocalOrcaProfile(now: number): OrcaProfileSummary {
  return {
    id: DEFAULT_LOCAL_ORCA_PROFILE_ID,
    name: DEFAULT_LOCAL_ORCA_PROFILE_NAME,
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function profilePartitionHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getOrcaProfileBrowserPartitionSegment(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'profile'
  return `${safe}-${profilePartitionHash(profileId)}`
}

export function getOrcaProfileBrowserDefaultPartition(profileId: string): string {
  if (profileId === DEFAULT_LOCAL_ORCA_PROFILE_ID) {
    return ORCA_BROWSER_PARTITION
  }
  return `persist:orca-profile-${getOrcaProfileBrowserPartitionSegment(profileId)}-browser-default`
}

export function getOrcaProfileBrowserSessionPartition(
  profileId: string,
  browserSessionProfileId: string
): string {
  if (profileId === DEFAULT_LOCAL_ORCA_PROFILE_ID) {
    return `${LEGACY_ORCA_BROWSER_SESSION_PARTITION_PREFIX}${browserSessionProfileId}`
  }
  return `persist:orca-profile-${getOrcaProfileBrowserPartitionSegment(
    profileId
  )}-browser-session-${browserSessionProfileId}`
}
