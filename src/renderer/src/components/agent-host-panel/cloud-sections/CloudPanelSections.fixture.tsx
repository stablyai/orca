import React from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  CloudSecretsCaller,
  CloudSecretsEffective,
  CloudWorkspaceSharing
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { CloudPanelSections } from './CloudPanelSections'
import { cloudPanelSectionsData, type CloudPanelSectionsLoad } from './use-cloud-panel-sections'

const UPDATED = 1_731_000_000_000
const PRECEDENCE: CloudSecretsEffective['precedence'] = {
  env: ['repo', 'personal', 'org'],
  agent_key: ['org', 'repo', 'personal']
}

const ADMIN: CloudSecretsCaller = {
  userId: 'u_ada',
  orgId: 'org_acme',
  orgRole: 'admin',
  canWrite: { personal: true, org: true, repo: true }
}
const MEMBER: CloudSecretsCaller = {
  userId: 'u_bo',
  orgId: 'org_acme',
  orgRole: 'member',
  canWrite: { personal: true, org: false, repo: false }
}

function effective(caller: CloudSecretsCaller): CloudSecretsEffective {
  return {
    caller,
    precedence: PRECEDENCE,
    secrets: [
      {
        name: 'OPENAI_API_KEY',
        kind: 'agent_key',
        scope: 'org',
        hint: 'M3kz',
        updatedAt: UPDATED,
        shadowed: [{ scope: 'personal', hint: '9f2c' }]
      },
      {
        name: 'ANTHROPIC_API_KEY',
        kind: 'agent_key',
        scope: 'repo',
        hint: 'a71b',
        updatedAt: UPDATED,
        shadowed: []
      },
      {
        name: 'DATABASE_URL',
        kind: 'env',
        scope: 'repo',
        hint: null,
        updatedAt: UPDATED,
        shadowed: [{ scope: 'personal', hint: null }]
      },
      {
        name: 'NPM_TOKEN',
        kind: 'env',
        scope: 'personal',
        hint: null,
        updatedAt: UPDATED,
        shadowed: []
      },
      {
        name: 'SENTRY_DSN',
        kind: 'env',
        scope: 'org',
        hint: null,
        updatedAt: UPDATED,
        shadowed: []
      }
    ]
  }
}

function ready(
  caller: CloudSecretsCaller,
  options: { asleep?: boolean; sharing?: CloudWorkspaceSharing } = {}
): CloudPanelSectionsLoad {
  return {
    status: 'ready',
    data: cloudPanelSectionsData({
      effective: effective(caller),
      envVarNames: ['DATABASE_URL', 'NPM_TOKEN', 'SENTRY_DSN', 'STRIPE_TEST_KEY'],
      repoKey: 'github.com/acme/web',
      asleep: options.asleep ?? false,
      sharing: options.sharing ?? null
    })
  }
}

const SHARED_GUEST: CloudWorkspaceSharing = {
  shared: true,
  ownerName: 'Ada Lovelace',
  isOwner: false
}

const noop = (): void => {}
const saved = async (): Promise<null> => null

/** Stands in for the panel shell (gap-agents' AgentHostPanel): 460 px, sections 2 and 3 only. */
function Frame({
  load,
  initialExpanded = null
}: {
  load: CloudPanelSectionsLoad
  initialExpanded?: string | null
}): React.JSX.Element {
  return (
    <div className="bg-background p-4">
      <div className="w-[460px] overflow-hidden rounded-xl border border-border bg-card">
        <CloudPanelSections
          load={load}
          onRetry={noop}
          onAdd={saved}
          onEdit={noop}
          onManage={noop}
          initialExpanded={initialExpanded}
        />
      </div>
    </div>
  )
}

export const admin = defineFixture({ width: 520, render: () => <Frame load={ready(ADMIN)} /> })

export const adminAdding = defineFixture({
  width: 520,
  render: () => <Frame load={ready(ADMIN)} initialExpanded="STRIPE_TEST_KEY" />
})

export const member = defineFixture({ width: 520, render: () => <Frame load={ready(MEMBER)} /> })

export const memberAdding = defineFixture({
  width: 520,
  render: () => <Frame load={ready(MEMBER)} initialExpanded="STRIPE_TEST_KEY" />
})

export const asleep = defineFixture({
  width: 520,
  render: () => <Frame load={ready(MEMBER, { asleep: true })} />
})

/** D13: a teammate in Ada's shared workspace. Their Personal values don't apply there. */
export const shared = defineFixture({
  width: 520,
  render: () => <Frame load={ready(MEMBER, { sharing: SHARED_GUEST })} />
})

export const sharedAsleep = defineFixture({
  width: 520,
  render: () => <Frame load={ready(MEMBER, { asleep: true, sharing: SHARED_GUEST })} />
})

export const sharedAdmin = defineFixture({
  width: 520,
  render: () => (
    <Frame load={ready(ADMIN, { sharing: SHARED_GUEST })} initialExpanded="STRIPE_TEST_KEY" />
  )
})

export const loading = defineFixture({
  width: 520,
  render: () => <Frame load={{ status: 'loading' }} />
})

export const failed = defineFixture({
  width: 520,
  render: () => <Frame load={{ status: 'failed', error: 'unavailable' }} />
})

export const empty = defineFixture({
  width: 520,
  render: () => (
    <Frame
      load={{
        status: 'ready',
        data: {
          effective: { caller: MEMBER, precedence: PRECEDENCE, secrets: [] },
          missing: [],
          repoKey: 'github.com/acme/web',
          asleep: false,
          sharing: null
        }
      }}
    />
  )
})
