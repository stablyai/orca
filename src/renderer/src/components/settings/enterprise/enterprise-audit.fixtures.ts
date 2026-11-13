// Sample audit log for the Enterprise settings fixtures and tests: one event from every source the
// control plane merges (API keys, secrets, members, workspaces, settings, apps), by current
// teammates, a former teammate, an API key, an agent and Orca itself. Names only, never values.
import type {
  CloudAuditActor,
  CloudAuditEvent
} from '../../../../../shared/cloud-api/cloud-api-types'
import type { EnterpriseAuditLogProps } from './EnterpriseAuditLog'

export const FIXTURE_NOW = Date.UTC(2026, 10, 12, 17, 30)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const ADA: CloudAuditActor = { kind: 'person', userId: 'u_ada', name: 'Ada Lovelace', via: null }
const GRACE: CloudAuditActor = {
  kind: 'person',
  userId: 'u_grace',
  name: 'Grace Hopper',
  via: null
}
const LINUS: CloudAuditActor = {
  kind: 'former_member',
  userId: 'u_linus',
  name: 'Linus Park',
  via: null
}
const SYSTEM: CloudAuditActor = { kind: 'system', userId: null, name: null, via: null }

export const FIXTURE_ACTORS: CloudAuditActor[] = [ADA, GRACE, LINUS]

export const FIXTURE_EVENTS: CloudAuditEvent[] = [
  {
    id: 'sev_9',
    at: FIXTURE_NOW - 4 * MIN,
    category: 'secrets',
    action: 'secret.updated',
    actor: GRACE,
    target: { type: 'secret', id: 'STRIPE_SECRET_KEY', label: 'STRIPE_SECRET_KEY' },
    detail: { scope: 'org' }
  },
  {
    id: 'aud_8',
    at: FIXTURE_NOW - 38 * MIN,
    category: 'members',
    action: 'member.role_changed',
    actor: ADA,
    target: { type: 'member', id: 'u_grace', label: 'Grace Hopper' },
    detail: { role: 'admin' }
  },
  {
    id: 'aud_7',
    at: FIXTURE_NOW - 3 * HOUR,
    category: 'workspaces',
    action: 'workspace.share_create',
    actor: GRACE,
    target: { type: 'workspace', id: 'sbx_7Hq2', label: 'checkout-redesign' },
    detail: { port: 3000, audience: 'team', expiresIn: '1d' }
  },
  {
    id: 'aud_6',
    at: FIXTURE_NOW - 5 * HOUR,
    category: 'workspaces',
    action: 'workspace.create',
    actor: { ...GRACE, via: 'api_key' },
    target: { type: 'workspace', id: 'sbx_2Lm9', label: 'nightly-evals' },
    detail: null
  },
  {
    id: 'aud_5',
    at: FIXTURE_NOW - 1 * DAY,
    category: 'members',
    action: 'member.removed',
    actor: ADA,
    target: { type: 'member', id: 'u_linus', label: 'Linus Park' },
    detail: { keysRevoked: 2, devicesRevoked: 1 }
  },
  {
    id: 'aud_4',
    at: FIXTURE_NOW - 1 * DAY - 2 * MIN,
    category: 'routines',
    action: 'routine.disable',
    actor: SYSTEM,
    target: { type: 'routine', id: 'rtn_41', label: null },
    detail: { reason: 'member_removed' }
  },
  {
    id: 'aud_3',
    at: FIXTURE_NOW - 2 * DAY,
    category: 'api_keys',
    action: 'api_key.create',
    actor: LINUS,
    target: { type: 'api_key', id: 'key_ci', label: 'GitHub Actions deploy' },
    detail: { name: 'GitHub Actions deploy' }
  },
  {
    id: 'sev_2',
    at: FIXTURE_NOW - 3 * DAY,
    category: 'secrets',
    action: 'secret.created',
    actor: ADA,
    target: { type: 'secret', id: 'ANTHROPIC_API_KEY', label: 'ANTHROPIC_API_KEY' },
    detail: { scope: 'repo', repo: 'github.com/acme/web' }
  },
  {
    id: 'aud_1',
    at: FIXTURE_NOW - 6 * DAY,
    category: 'settings',
    action: 'settings.update',
    actor: ADA,
    target: { type: 'account', id: 'org:acme', label: null },
    detail: { vmCliEnabled: true }
  },
  {
    id: 'aud_0',
    at: FIXTURE_NOW - 9 * DAY,
    category: 'apps',
    action: 'mcp.authorize',
    actor: { ...GRACE, via: 'mcp' },
    target: { type: 'oauth_client', id: 'cl_4q', label: null },
    detail: null
  }
]

const noop = (): void => {}

/** OWNER-TRANSFER: an owner change, and Orca's own row about telling the previous owner. */
export const OWNER_CHANGE_EVENTS: CloudAuditEvent[] = [
  {
    id: 'aud_own_4',
    at: FIXTURE_NOW - 2 * MIN + 1,
    category: 'workspaces',
    action: 'workspace.owner_notified',
    actor: SYSTEM,
    target: { type: 'workspace', id: 'sbx_7Hq2', label: 'checkout-redesign' },
    detail: { toUserId: 'u_grace', toUserName: 'Grace Hopper', reached: true, inApp: true }
  },
  {
    id: 'aud_own_3',
    at: FIXTURE_NOW - 2 * MIN,
    category: 'workspaces',
    action: 'workspace.owner_changed',
    actor: ADA,
    target: { type: 'workspace', id: 'sbx_7Hq2', label: 'checkout-redesign' },
    detail: { fromUserId: 'u_grace', toUserId: 'u_ada' }
  },
  {
    id: 'aud_own_2',
    at: FIXTURE_NOW - 3 * HOUR + 1,
    category: 'workspaces',
    action: 'workspace.owner_notified',
    actor: SYSTEM,
    target: {
      type: 'workspace',
      id: 'sbx_9Kd1',
      label: 'payments-refund-webhooks-retry-queue-investigation'
    },
    detail: {
      toUserId: 'u_linus',
      toUserName: 'Linus Park',
      toUserFormer: true,
      reached: false,
      inApp: false
    }
  },
  {
    id: 'aud_own_1',
    at: FIXTURE_NOW - 3 * HOUR,
    category: 'workspaces',
    action: 'workspace.owner_changed',
    actor: ADA,
    target: {
      type: 'workspace',
      id: 'sbx_9Kd1',
      label: 'payments-refund-webhooks-retry-queue-investigation'
    },
    detail: { fromUserId: 'u_linus', toUserId: 'u_grace', toUserName: 'Grace Hopper' }
  }
]

export function fixtureAuditProps(
  patch: Partial<EnterpriseAuditLogProps> = {}
): EnterpriseAuditLogProps {
  return {
    log: {
      status: 'ok',
      events: FIXTURE_EVENTS,
      hasMore: true,
      loadingMore: false,
      moreError: null,
      refreshing: false
    },
    filters: { category: null, actor: null },
    actors: FIXTURE_ACTORS,
    exportState: { status: 'idle' },
    now: FIXTURE_NOW,
    viewerUserId: 'u_ada',
    contact: { planName: 'Enterprise', contactUrl: 'https://orca.dev/enterprise' },
    onFilter: noop,
    onLoadMore: noop,
    onRetry: noop,
    onExport: noop,
    onContactSales: noop,
    ...patch
  }
}
