import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  CloudApiGrant,
  CloudApiAuditPage,
  CloudApiKeyList,
  CloudApiMe,
  CloudApiSettings
} from '../../../../../shared/cloud-api/cloud-api-types'
import { CLOUD_API_SCOPES } from '../../../../../shared/cloud-api/cloud-api-types'
import { CloudApiKeysView, type CloudApiKeysViewProps } from './CloudApiKeysView'

const NOW = Date.UTC(2026, 10, 9, 15, 0)
const MIN = 60_000
const DAY = 86_400_000

const ADMIN: CloudApiMe = {
  accountId: 'org:acme',
  userId: 'u_ada',
  orgId: 'acme',
  role: 'admin',
  scopes: [...CLOUD_API_SCOPES]
}
const MEMBER: CloudApiMe = {
  ...ADMIN,
  userId: 'u_linus',
  role: 'member',
  scopes: CLOUD_API_SCOPES.filter((s) => s !== 'audit:read')
}

const KEYS: CloudApiKeyList = {
  availableScopes: [...CLOUD_API_SCOPES],
  keys: [
    {
      id: 'key_ci',
      name: 'GitHub Actions deploy',
      prefix: 'orca_sk_Ab3x',
      scopes: ['workspaces:read', 'workspaces:write', 'messages:write'],
      createdBy: 'u_ada',
      createdAt: NOW - 3 * DAY,
      lastUsedAt: NOW - 5 * MIN,
      expiresAt: NOW + 87 * DAY
    },
    {
      id: 'key_dash',
      name: 'Grafana dashboard',
      prefix: 'orca_sk_Q9zL',
      scopes: ['workspaces:read', 'projects:read', 'routines:read'],
      createdBy: 'u_grace',
      createdAt: NOW - 40 * DAY,
      lastUsedAt: NOW - 2 * 3_600_000,
      expiresAt: null
    },
    {
      id: 'key_old',
      name: 'Laptop script',
      prefix: 'orca_sk_m2Pe',
      scopes: [...CLOUD_API_SCOPES],
      createdBy: 'u_ada',
      createdAt: NOW - 85 * DAY,
      lastUsedAt: null,
      expiresAt: NOW + 4 * DAY
    }
  ]
}

const SETTINGS: CloudApiSettings = { settings: { vmCliEnabled: true }, canEdit: true }
const AUDIT: CloudApiAuditPage = {
  nextBefore: null,
  entries: [
    {
      id: 'a1',
      actor: { type: 'user', id: 'u_ada', userId: 'u_ada' },
      action: 'api_key.create',
      target: { type: 'api_key', id: 'key_ci' },
      detail: { name: 'GitHub Actions deploy' },
      createdAt: NOW - 3 * DAY
    },
    {
      id: 'a2',
      actor: { type: 'api_key', id: 'key_ci', userId: 'u_ada' },
      action: 'workspace.create',
      target: { type: 'workspace', id: 'sbx_7Hq2' },
      createdAt: NOW - 5 * MIN
    },
    {
      id: 'a3',
      actor: { type: 'workspace_token', id: 'key_ws', userId: 'u_ada' },
      action: 'workspace.message',
      target: { type: 'workspace', id: 'sbx_7Hq2' },
      createdAt: NOW - 2 * MIN
    }
  ]
}

const GRANTS: CloudApiGrant[] = [
  {
    id: 'fam_claude',
    clientId: 'cl_9x',
    clientName: 'Claude Desktop',
    redirectHosts: ['claude.ai'],
    userId: 'u_ada',
    scopes: ['workspaces:read', 'workspaces:write', 'messages:write', 'routines:read'],
    approvedWith: { approvalCode: true },
    grantedAt: NOW - 2 * DAY,
    lastUsedAt: NOW - 12 * MIN,
    expiresAt: NOW + 88 * DAY
  },
  {
    id: 'fam_cursor',
    clientId: 'cl_4q',
    clientName: 'Cursor',
    redirectHosts: ['127.0.0.1'],
    userId: 'u_grace',
    scopes: ['workspaces:read', 'projects:read'],
    approvedWith: { apiKeyPrefix: 'orca_sk_Q9zL' },
    grantedAt: NOW - 9 * DAY,
    lastUsedAt: null,
    expiresAt: NOW + 81 * DAY
  }
]

const base: CloudApiKeysViewProps = {
  controlPlaneUrl: 'https://api.orca.dev',
  viewer: ADMIN,
  keys: { status: 'ok', data: KEYS },
  settings: { status: 'ok', data: SETTINGS },
  audit: { status: 'ok', data: AUDIT },
  now: NOW,
  onRefresh: () => {},
  onCreate: async () => ({ ok: false, error: 'server' }),
  onRevoke: async () => null,
  onToggleVmCli: async () => null,
  onLoadAudit: () => {},
  onCreateApproval: async () => ({ ok: false, error: 'server' }),
  grants: { status: 'ok', data: [] },
  onRevokeGrant: async () => null,
  onRefreshGrants: () => {}
}

export const list = defineFixture({
  width: 760,
  render: () => <CloudApiKeysView {...base} grants={{ status: 'ok', data: GRANTS }} />
})

export const disconnectAppConfirm = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      grants={{ status: 'ok', data: GRANTS }}
      initial={{ revokeGrantId: 'fam_cursor' }}
    />
  )
})

export const listWithActivity = defineFixture({
  width: 760,
  render: () => <CloudApiKeysView {...base} initial={{ auditOpen: true }} />
})

export const empty = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      viewer={{ ...ADMIN, orgId: null, role: 'owner' }}
      keys={{ status: 'ok', data: { ...KEYS, keys: [] } }}
      settings={{ status: 'ok', data: { settings: { vmCliEnabled: false }, canEdit: true } }}
    />
  )
})

export const loading = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      keys={{ status: 'loading' }}
      grants={{ status: 'loading' }}
      settings={{ status: 'loading' }}
      audit={null}
    />
  )
})

export const error = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      keys={{
        status: 'error',
        message: 'Could not reach Orca Cloud. Check your connection and try again.'
      }}
      settings={{ status: 'error', message: 'Could not reach Orca Cloud.' }}
      grants={{ status: 'error', message: 'Could not reach Orca Cloud.' }}
      audit={null}
    />
  )
})

export const memberView = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      viewer={MEMBER}
      keys={{
        status: 'ok',
        data: { availableScopes: MEMBER.scopes, keys: [{ ...KEYS.keys[0]!, createdBy: 'u_linus' }] }
      }}
      settings={{ status: 'ok', data: { settings: { vmCliEnabled: false }, canEdit: false } }}
      audit={null}
    />
  )
})

export const createDialog = defineFixture({
  width: 760,
  render: () => <CloudApiKeysView {...base} initial={{ create: true }} />
})

export const createDialogMemberCustom = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      viewer={MEMBER}
      keys={{ status: 'ok', data: { availableScopes: MEMBER.scopes, keys: [] } }}
      audit={null}
      initial={{ create: true }}
    />
  ),
  interact: async () => {
    const custom = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent === 'Custom'
    )
    custom?.click()
  }
})

export const justCreated = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      initial={{
        created: {
          key: KEYS.keys[0]!,
          secret: 'orca_sk_Ab3xR7tQm2LpV9cWfK4nY8sJd1Hg6ZeB'
        }
      }}
    />
  )
})

export const revokeConfirm = defineFixture({
  width: 760,
  render: () => <CloudApiKeysView {...base} initial={{ revokeKeyId: 'key_dash' }} />
})

export const approveAppCode = defineFixture({
  width: 760,
  render: () => (
    <CloudApiKeysView
      {...base}
      initial={{
        approval: {
          code: 'orca_ap_7KqW2nV9xLm4Rt8YpZ3cBd6Hs1FgJe0A',
          expiresAt: NOW + 9 * MIN + 42_000,
          scopes: ['workspaces:read', 'projects:read', 'routines:read']
        }
      }}
    />
  )
})
