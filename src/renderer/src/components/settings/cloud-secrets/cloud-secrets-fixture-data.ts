// Fixture-only fake of the cloud secrets bridge: canned names and hints, never values.
import type {
  CloudSecretScope,
  CloudSecretView,
  CloudSecretsCaller,
  CloudSecretsEffective,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import type { CloudSecretsApi } from './use-cloud-secrets'

const NOW = Date.now()
const HOUR = 3_600_000

export const FIXTURE_ADMIN: CloudSecretsCaller = {
  userId: 'u_me',
  orgId: 'org_acme',
  orgRole: 'admin',
  canWrite: { personal: true, org: true, repo: true }
}
export const FIXTURE_MEMBER: CloudSecretsCaller = {
  ...FIXTURE_ADMIN,
  orgRole: 'member',
  canWrite: { personal: true, org: false, repo: false }
}
export const FIXTURE_SOLO: CloudSecretsCaller = {
  userId: 'u_me',
  orgId: null,
  orgRole: null,
  canWrite: { personal: true, org: false, repo: true }
}

function view(
  scope: CloudSecretScope,
  name: string,
  kind: CloudSecretView['kind'],
  hint: string | null,
  ageHours: number,
  updatedBy = 'u_me'
): CloudSecretView {
  return { scope, name, kind, hint, updatedAt: NOW - ageHours * HOUR, updatedBy }
}

export const FIXTURE_SECRETS: Record<CloudSecretScope, CloudSecretView[]> = {
  personal: [
    view('personal', 'ANTHROPIC_API_KEY', 'agent_key', 'x7Qa', 2),
    view('personal', 'GITHUB_PACKAGES_TOKEN', 'env', '9fd2', 50),
    view('personal', 'SENTRY_ENV', 'env', null, 400)
  ],
  org: [
    view('org', 'AI_GATEWAY_API_KEY', 'agent_key', 'M3kz', 30, 'u_dana'),
    view('org', 'ANTHROPIC_MODEL', 'agent_key', 'et-4', 30, 'u_dana'),
    view('org', 'NPM_TOKEN', 'env', 'c0de', 170, 'u_ravi')
  ],
  repo: [
    view('repo', 'DATABASE_URL', 'env', '/app', 5, 'u_ravi'),
    view('repo', 'STRIPE_SECRET_KEY', 'env', 'Lq1T', 26),
    view('repo', 'ANTHROPIC_API_KEY', 'agent_key', 'p0Zz', 72, 'u_dana')
  ]
}

export const FIXTURE_EFFECTIVE_SECRETS: CloudSecretsEffective['secrets'] = [
  {
    name: 'AI_GATEWAY_API_KEY',
    kind: 'agent_key',
    scope: 'org',
    hint: 'M3kz',
    updatedAt: NOW,
    shadowed: []
  },
  {
    name: 'ANTHROPIC_API_KEY',
    kind: 'agent_key',
    scope: 'repo',
    hint: 'p0Zz',
    updatedAt: NOW,
    shadowed: [{ scope: 'personal', hint: 'x7Qa' }]
  },
  {
    name: 'DATABASE_URL',
    kind: 'env',
    scope: 'repo',
    hint: '/app',
    updatedAt: NOW,
    shadowed: []
  },
  {
    name: 'NPM_TOKEN',
    kind: 'env',
    scope: 'org',
    hint: 'c0de',
    updatedAt: NOW,
    shadowed: []
  },
  {
    name: 'SENTRY_ENV',
    kind: 'env',
    scope: 'personal',
    hint: null,
    updatedAt: NOW,
    shadowed: [{ scope: 'org', hint: null }]
  }
]

export const FIXTURE_NAMES: Record<string, string> = { u_dana: 'Dana Reyes', u_ravi: 'Ravi Shah' }

const never = <T>(): Promise<T> => new Promise<T>(() => {})

export function fixtureCloudSecretsApi(options: {
  caller?: CloudSecretsCaller
  secrets?: Partial<Record<CloudSecretScope, CloudSecretView[]>>
  effective?: CloudSecretsEffective['secrets']
  /** Every list read fails with this code. */
  listError?: CloudSecretsErrorCode
  /** Reads never answer (loading state). */
  pending?: boolean
  /** Writes never answer (saving state). */
  pendingWrites?: boolean
}): CloudSecretsApi {
  const caller = options.caller ?? FIXTURE_ADMIN
  const secrets = options.secrets ?? FIXTURE_SECRETS
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
  return {
    status: () => Promise.resolve({ available: true }),
    list: (target) =>
      options.pending
        ? never()
        : options.listError
          ? Promise.resolve({ ok: false as const, error: options.listError })
          : ok(secrets[target.scope] ?? []),
    put: ({ target, name }) =>
      options.pendingWrites ? never() : ok(view(target.scope, name, 'env', null, 0, caller.userId)),
    remove: () => (options.pendingWrites ? never() : ok(true as const)),
    batch: ({ target, set }) =>
      options.pendingWrites
        ? never()
        : ok({
            secrets: Object.keys(set ?? {}).map((name) =>
              view(target.scope, name, 'env', null, 0, caller.userId)
            ),
            deleted: [],
            errors: []
          }),
    effective: () =>
      options.pending
        ? never()
        : ok({
            caller,
            precedence: {
              env: ['repo', 'personal', 'org'],
              agent_key: ['org', 'repo', 'personal']
            },
            secrets: options.effective ?? FIXTURE_EFFECTIVE_SECRETS
          }),
    refreshEnv: () => ok(true)
  }
}
