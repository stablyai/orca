// Static team, workspaces and API stubs shared by the cloud workspaces component fixtures.
import type {
  CloudWorkspace,
  CloudWorkspacePresence
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { OrcaOrgMembersRoster, OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import type { CloudWorkspacesApi } from '../../../../preload/api/cloud-workspaces-api'
import type { MemberDirectory } from './cloud-workspace-format'

// Relative to the render so "4m ago" style labels stay stable in every capture.
export const FIXTURE_NOW = Date.now()
export const SELF_ID = 'user_ada'

export const ROSTER: OrcaOrgMembersRoster = {
  members: [
    { userId: SELF_ID, email: 'ada@acme.dev', displayName: 'Ada Lovelace', role: 'owner' },
    { userId: 'user_grace', email: 'grace@acme.dev', displayName: 'Grace Hopper', role: 'admin' },
    { userId: 'user_linus', email: 'linus@acme.dev', displayName: 'Linus Park', role: 'member' },
    { userId: 'user_mae', email: 'mae@acme.dev', displayName: 'Mae Jemison', role: 'member' },
    { userId: 'user_alan', email: 'alan@acme.dev', displayName: 'Alan Kay', role: 'member' }
  ],
  pendingInvites: [],
  viewerRole: 'owner',
  canManageMembers: true
}

export const DIRECTORY: MemberDirectory = new Map(
  ROSTER.members.flatMap((m) =>
    m.userId ? [[m.userId, { name: m.displayName ?? m.email, email: m.email }]] : []
  )
)

export const AUTH_STATUS: OrcaProfileAuthStatus = {
  activeProfileId: 'profile-1',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'cloud-1',
    userId: SELF_ID,
    email: 'ada@acme.dev',
    displayName: 'Ada Lovelace',
    activeOrgId: 'org_acme',
    activeOrgName: 'Acme',
    linkedAt: FIXTURE_NOW
  }
}

export function presence(
  userId: string,
  state: CloudWorkspacePresence['state'] = 'viewing'
): CloudWorkspacePresence {
  return { userId, clientId: `desktop-${userId}`, state, chatId: 's:ses_1', at: FIXTURE_NOW }
}

let next = 0
export function workspace(overrides: Partial<CloudWorkspace>): CloudWorkspace {
  next += 1
  const hex = next.toString(16).padStart(24, '0')
  return {
    id: `sbx_${hex}`,
    workspaceId: `ws_${hex}`,
    status: 'running',
    machineSize: 'standard',
    region: 'iad1',
    createdAt: FIXTURE_NOW - 86_400_000,
    title: null,
    repo: { url: 'https://github.com/acme/payments.git', branch: 'main' },
    visibility: 'team',
    section: null,
    archivedAt: null,
    createdBy: SELF_ID,
    ownerUserId: SELF_ID,
    lastActivityAt: FIXTURE_NOW - 4 * 60_000,
    lastActivityBy: SELF_ID,
    cost: {
      computeMs: 2.6 * 3_600_000,
      rateUsdMicrosPerHour: 750_000,
      computeUsdMicros: 1_950_000,
      tokenUsdMicros: 410_000,
      totalUsdMicros: 2_360_000
    },
    access: 'owner',
    presence: [],
    ...overrides
  }
}

/** One of each lifecycle state the list shows, across two sections and several owners. */
export function teamWorkspaces(): CloudWorkspace[] {
  return [
    workspace({
      title: 'Checkout retries',
      section: 'Payments',
      presence: [presence('user_grace', 'typing'), presence('user_linus')]
    }),
    workspace({
      repo: { url: 'https://github.com/acme/payments.git', branch: 'refund-webhooks' },
      section: 'Payments',
      ownerUserId: 'user_grace',
      createdBy: 'user_grace',
      access: 'can_open',
      status: 'suspended',
      lastActivityAt: FIXTURE_NOW - 3 * 3_600_000
    }),
    workspace({
      title: 'Ledger migration',
      section: 'Payments',
      ownerUserId: 'user_linus',
      createdBy: 'user_linus',
      access: 'can_open',
      status: 'resuming'
    }),
    workspace({
      title: 'Docs search',
      repo: { url: 'https://github.com/acme/docs.git', branch: 'search' },
      ownerUserId: 'user_mae',
      createdBy: 'user_mae',
      access: 'can_open',
      status: 'creating',
      cost: {
        computeMs: 6 * 60_000,
        rateUsdMicrosPerHour: 750_000,
        computeUsdMicros: 75_000,
        tokenUsdMicros: null,
        totalUsdMicros: 75_000
      }
    }),
    workspace({
      title: 'Flaky e2e repro',
      repo: { url: 'https://github.com/acme/web.git', branch: 'fix-e2e' },
      visibility: 'private',
      status: 'failed',
      lastActivityAt: FIXTURE_NOW - 26 * 3_600_000
    }),
    workspace({
      title: 'Design tokens spike',
      repo: { url: 'https://github.com/acme/web.git', branch: null },
      ownerUserId: 'user_alan',
      createdBy: 'user_alan',
      access: 'can_open',
      archivedAt: FIXTURE_NOW - 5 * 86_400_000,
      status: 'suspended',
      lastActivityAt: FIXTURE_NOW - 6 * 86_400_000
    })
  ]
}

type ListResult = Awaited<ReturnType<CloudWorkspacesApi['list']>>

/** Replaces the web build's "not configured" cloud workspaces bridge with static answers. */
export function stubCloudWorkspacesApi(list: () => Promise<ListResult>): void {
  Object.assign(window.api.cloudWorkspaces, {
    available: () => Promise.resolve(true),
    list,
    localWorkspaces: () => Promise.resolve([]),
    environmentBindings: () => Promise.resolve({})
  } satisfies Partial<CloudWorkspacesApi>)
  Object.assign(window.api.orcaProfiles, {
    orgMembersList: () => Promise.resolve({ status: 'ok' as const, roster: ROSTER })
  })
}
