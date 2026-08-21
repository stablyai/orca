import { MCODE_BROWSER_PARTITION } from './constants'
import type { ExecutionHostId } from './execution-host'

export const MCODE_PROFILE_INDEX_SCHEMA_VERSION = 1
export const DEFAULT_LOCAL_MCODE_PROFILE_ID = 'local-default'
export const DEFAULT_LOCAL_MCODE_PROFILE_NAME = 'Personal'
const LEGACY_MCODE_BROWSER_SESSION_PARTITION_PREFIX = 'persist:mcode-browser-session-'

export type MCodeProfileAvatar = {
  kind: 'initials'
  initials: string
  color: 'neutral'
}

export type MCodeProfileKind = 'local' | 'cloud-linked'

export type MCodeProfileCloudSummary = {
  cloudProfileId: string
  userId: string
  email: string
  displayName?: string
  activeOrgId?: string
  activeOrgName?: string
  linkedAt: number
}

export type MCodeCloudOrgSummary = {
  orgId: string
  name: string
  role?: string
}

export type MCodeCloudCapabilityFlags = Record<string, boolean>

export type MCodeCloudCapabilities = {
  flags: MCodeCloudCapabilityFlags
  refreshedAt: number
}

export type MCodeCloudSessionPersistence = 'none' | 'encrypted' | 'memory-only' | 'dev-plaintext'

export type MCodeProfileAuthState = 'local' | 'unconfigured' | 'connected' | 'reconnect-required'

export type MCodeProfileAuthStatus = {
  activeProfileId: string
  configured: boolean
  state: MCodeProfileAuthState
  persistence: MCodeCloudSessionPersistence
  cloud?: MCodeProfileCloudSummary
  organizations?: MCodeCloudOrgSummary[]
  capabilities?: MCodeCloudCapabilities
  credentialError?: string
  setupMessage?: string
}

export type MCodeProfileSummary = {
  id: string
  name: string
  avatar: MCodeProfileAvatar
  kind: MCodeProfileKind
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  cloud?: MCodeProfileCloudSummary
}

export type MCodeProfileIndex = {
  schemaVersion: number
  activeProfileId: string
  profiles: MCodeProfileSummary[]
}

export type MCodeProfileListState = {
  activeProfileId: string
  profiles: MCodeProfileSummary[]
}

export type MCodeProfileListResult = MCodeProfileListState & {
  // Why: gates the full multi-profile switcher UI; default builds show a
  // single-profile account menu instead.
  multiProfileUi: boolean
}

export type CreateLocalMCodeProfileArgs = {
  name?: string
}

export type CreateLocalMCodeProfileResult = MCodeProfileListState & {
  profile: MCodeProfileSummary
}

export type CreateCloudLinkedMCodeProfileArgs = {
  orgId?: string
  name?: string
}

export type SwitchMCodeProfileArgs = {
  profileId: string
}

export type SwitchMCodeProfileResult = {
  status: 'already-active' | 'relaunching'
}

export type TransferMCodeProfileProjectMode = 'move' | 'copy'

export type TransferMCodeProfileProjectArgs = {
  sourceProfileId: string
  targetProfileId: string
  repoId: string
  mode: TransferMCodeProfileProjectMode
}

export type FindMCodeProfileProjectsByPathArgs = {
  path: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  excludeProfileId?: string | null
}

export type MCodeProfileProjectPresence = {
  profileId: string
  profileName: string
  profileKind: MCodeProfileKind
  repoId: string
  repoName: string
}

export type FindMCodeProfileProjectsByPathResult = {
  projects: MCodeProfileProjectPresence[]
}

export type TransferMCodeProfileProjectResult =
  | {
      status: 'transferred'
      mode: TransferMCodeProfileProjectMode
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

export type ConnectCurrentMCodeProfileResult =
  | {
      status: 'connected'
      auth: MCodeProfileAuthStatus
      activeProfileId: string
      profiles: MCodeProfileSummary[]
    }
  | {
      status: 'unconfigured'
      auth: MCodeProfileAuthStatus
    }
  | {
      status: 'cancelled'
      auth: MCodeProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: MCodeProfileAuthStatus
      error: string
    }

export type CreateCloudLinkedMCodeProfileResult =
  | {
      status: 'created'
      auth: MCodeProfileAuthStatus
      activeProfileId: string
      profiles: MCodeProfileSummary[]
      profile: MCodeProfileSummary
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: MCodeProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: MCodeProfileAuthStatus
      error: string
    }

export type SignOutCurrentMCodeProfileResult = {
  status: 'signed-out'
  auth: MCodeProfileAuthStatus
  activeProfileId: string
  profiles: MCodeProfileSummary[]
}

export type SelectMCodeProfileOrgArgs = {
  orgId: string
}

export type SelectMCodeProfileOrgResult =
  | {
      status: 'selected'
      auth: MCodeProfileAuthStatus
      activeProfileId: string
      profiles: MCodeProfileSummary[]
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: MCodeProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: MCodeProfileAuthStatus
      error: string
    }

export type RefreshCurrentMCodeProfileAuthResult =
  | {
      status: 'refreshed'
      auth: MCodeProfileAuthStatus
      activeProfileId: string
      profiles: MCodeProfileSummary[]
    }
  | {
      status: 'local' | 'unconfigured' | 'reconnect-required'
      auth: MCodeProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: MCodeProfileAuthStatus
      error: string
    }

// Why: organization roles are a fixed server-side enum; the desktop UI mirrors
// exactly these three so role selects can't drift from what the API accepts.
export type MCodeOrgRole = 'owner' | 'admin' | 'member'

export type MCodeOrgMember = {
  // Why: null for teammates provisioned server-side who never signed into MCode;
  // mutation actions are disabled for them since the API keys on a real userId.
  userId: string | null
  email: string
  displayName?: string
  role: MCodeOrgRole
}

export type MCodeOrgPendingInvite = {
  email: string
  role: MCodeOrgRole
  createdAt: number
}

export type MCodeOrgMembersRoster = {
  members: MCodeOrgMember[]
  pendingInvites: MCodeOrgPendingInvite[]
  viewerRole: MCodeOrgRole
  canManageMembers: boolean
}

export type MCodeProfileOrgMembersListArgs = {
  orgId: string
}

export type MCodeProfileOrgMemberInviteArgs = {
  orgId: string
  email: string
  role: MCodeOrgRole
}

export type MCodeProfileOrgInviteRevokeArgs = {
  orgId: string
  email: string
}

export type MCodeProfileOrgMemberChangeRoleArgs = {
  orgId: string
  userId: string
  role: MCodeOrgRole
}

export type MCodeProfileOrgMemberRemoveArgs = {
  orgId: string
  userId: string
}

export type MCodeProfileOrgMembersListResult =
  | { status: 'ok'; roster: MCodeOrgMembersRoster }
  | { status: 'unconfigured' | 'reconnect-required' }
  | { status: 'failed'; error: string }

export type MCodeOrgInviteConflictReason = 'already_member' | 'already_invited'
export type MCodeOrgMutationInvalidReason = 'cannot_change_own_role' | 'cannot_remove_self'

export type MCodeProfileOrgMemberMutationResult =
  | { status: 'ok' }
  | { status: 'unconfigured' | 'reconnect-required' | 'forbidden' | 'not-found' }
  | { status: 'conflict'; reason: MCodeOrgInviteConflictReason }
  | { status: 'invalid'; reason: MCodeOrgMutationInvalidReason }
  | { status: 'failed'; error: string }

export function createDefaultLocalMCodeProfile(now: number): MCodeProfileSummary {
  return {
    id: DEFAULT_LOCAL_MCODE_PROFILE_ID,
    name: DEFAULT_LOCAL_MCODE_PROFILE_NAME,
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

export function getMCodeProfileBrowserPartitionSegment(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'profile'
  return `${safe}-${profilePartitionHash(profileId)}`
}

export function getMCodeProfileBrowserDefaultPartition(profileId: string): string {
  if (profileId === DEFAULT_LOCAL_MCODE_PROFILE_ID) {
    return MCODE_BROWSER_PARTITION
  }
  return `persist:mcode-profile-${getMCodeProfileBrowserPartitionSegment(profileId)}-browser-default`
}

export function getMCodeProfileBrowserSessionPartition(
  profileId: string,
  browserSessionProfileId: string
): string {
  if (profileId === DEFAULT_LOCAL_MCODE_PROFILE_ID) {
    return `${LEGACY_MCODE_BROWSER_SESSION_PARTITION_PREFIX}${browserSessionProfileId}`
  }
  return `persist:mcode-profile-${getMCodeProfileBrowserPartitionSegment(
    profileId
  )}-browser-session-${browserSessionProfileId}`
}
