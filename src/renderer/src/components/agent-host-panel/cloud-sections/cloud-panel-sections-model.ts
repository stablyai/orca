// Rows for the Orca Cloud panel's sections 2 (API keys from Cloud secrets) and 3 (Environment).
// Pure: names, scopes and hints only.
import { AGENT_CREDENTIAL_NAMES } from '../../../../../shared/agent-credentials/agent-credential-names'
import type {
  CloudEffectiveSecret,
  CloudSecretScope,
  CloudSecretsCaller,
  CloudSecretsEffective
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { effectiveOfKind } from '../../cloud-secrets-ask/cloud-secrets-ask-model'

/** Which agent a Cloud-secret key serves, for the row label. Shared names (gateway, AWS) say so. */
export type CloudKeyOwner =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'copilot'
  | 'gateway'
  | 'aws'
  | 'other'

const OWNER_ORDER: readonly CloudKeyOwner[] = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'copilot',
  'gateway',
  'aws',
  'other'
]

export function cloudKeyOwner(name: string): CloudKeyOwner {
  if (AGENT_CREDENTIAL_NAMES.claude.includes(name)) {
    return 'claude'
  }
  if (AGENT_CREDENTIAL_NAMES.codex.includes(name)) {
    return 'codex'
  }
  if (name.startsWith('GEMINI_') || name.startsWith('GOOGLE_')) {
    return 'gemini'
  }
  if (name.startsWith('CURSOR_')) {
    return 'cursor'
  }
  if (name.startsWith('COPILOT_')) {
    return 'copilot'
  }
  if (name === 'AI_GATEWAY_API_KEY') {
    return 'gateway'
  }
  if (name.startsWith('AWS_')) {
    return 'aws'
  }
  return 'other'
}

export type ShadowedKey = {
  scope: CloudSecretScope
  hint: string | null
  /** Why it's not used: the winner's scope ('org' reads "team key", 'repo' "repository key"). */
  shadowedBy: CloudSecretScope
}

export type CloudKeyRow = {
  owner: CloudKeyOwner
  name: string
  scope: CloudSecretScope
  hint: string | null
  /** The caller may change the winning value (members can't touch Shared or Repository). */
  editable: boolean
  shadowed: ShadowedKey[]
}

function canWriteScope(
  caller: Pick<CloudSecretsCaller, 'canWrite'>,
  scope: CloudSecretScope
): boolean {
  return scope === 'org'
    ? caller.canWrite.org
    : scope === 'repo'
      ? caller.canWrite.repo
      : caller.canWrite.personal
}

/** Section 2: one row per agent key name, the winner first, the keys it hides listed under it. */
export function cloudKeyRows(effective: CloudSecretsEffective): CloudKeyRow[] {
  return effectiveOfKind(effective, 'agent_key')
    .map((secret) => ({
      owner: cloudKeyOwner(secret.name),
      name: secret.name,
      scope: secret.scope,
      hint: secret.hint,
      editable: canWriteScope(effective.caller, secret.scope),
      shadowed: secret.shadowed.map((entry) => ({
        scope: entry.scope,
        hint: entry.hint,
        shadowedBy: secret.scope
      }))
    }))
    .sort(
      (a, b) =>
        OWNER_ORDER.indexOf(a.owner) - OWNER_ORDER.indexOf(b.owner) || a.name.localeCompare(b.name)
    )
}

type CloudEnvRow =
  | {
      kind: 'set'
      name: string
      scope: CloudSecretScope
      /** Scopes this value overrides, in precedence order. */
      overrides: CloudSecretScope[]
    }
  | { kind: 'missing'; name: string }

/**
 * Section 3: variables the workspace gets (with the scope that wins), then the environment's declared
 * names nobody provides.
 */
export function cloudEnvRows(
  effective: CloudSecretsEffective,
  missing: readonly string[]
): CloudEnvRow[] {
  const set: CloudEnvRow[] = effectiveOfKind(effective, 'env').map(
    (secret: CloudEffectiveSecret) => ({
      kind: 'set',
      name: secret.name,
      scope: secret.scope,
      overrides: secret.shadowed.map((entry) => entry.scope)
    })
  )
  return [...set, ...missing.map((name): CloudEnvRow => ({ kind: 'missing', name }))]
}

/**
 * What a teammate who doesn't own a shared workspace actually gets there: the owner's Personal values
 * apply, not theirs, so the caller's Personal winners give way to the next scope (or drop out).
 */
export function withoutCallerPersonal(effective: CloudSecretsEffective): CloudSecretsEffective {
  const secrets: CloudEffectiveSecret[] = []
  for (const secret of effective.secrets) {
    const chain = [{ scope: secret.scope, hint: secret.hint }, ...secret.shadowed].filter(
      (entry) => entry.scope !== 'personal'
    )
    const [winner, ...rest] = chain
    if (winner) {
      secrets.push({ ...secret, scope: winner.scope, hint: winner.hint, shadowed: rest })
    }
  }
  return { ...effective, secrets }
}
