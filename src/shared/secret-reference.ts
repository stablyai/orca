export const SECRET_REFERENCE_PREFIX = 'doppler-ref:'
export const APPROVED_SECRET_REFERENCE_NAMES = ['POSTHOG_READ_ONLY', 'LINEAR_API_KEY'] as const
export type ApprovedSecretReferenceName = (typeof APPROVED_SECRET_REFERENCE_NAMES)[number]

export type SecretReference = {
  readonly project: string
  readonly config: string
  readonly name: ApprovedSecretReferenceName
}

export type SecretReferenceValidation =
  | { readonly ok: true; readonly reference: SecretReference }
  | {
      readonly ok: false
      readonly code: 'malformed' | 'key-name-mismatch' | 'name-not-approved'
    }

export type AgentEnvSecretReferenceClassification =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'valid'
      readonly entries: readonly { readonly key: string; readonly reference: SecretReference }[]
    }
  | { readonly kind: 'invalid'; readonly keys: readonly string[] }

const SECRET_REFERENCE_PATTERN = /^doppler-ref:\/\/([^/\s?#]+)\/([^/\s?#]+)\/([^/\s?#]+)$/

export function isSecretReferenceCandidate(value: string): boolean {
  return value.startsWith(SECRET_REFERENCE_PREFIX)
}

export function validateSecretReference(envKey: string, value: string): SecretReferenceValidation {
  if (/\s/.test(value)) {
    return { ok: false, code: 'malformed' }
  }
  const match = SECRET_REFERENCE_PATTERN.exec(value)
  if (!match) {
    return { ok: false, code: 'malformed' }
  }
  const [, project, config, name] = match
  if (envKey !== name) {
    return { ok: false, code: 'key-name-mismatch' }
  }
  if (!(APPROVED_SECRET_REFERENCE_NAMES as readonly string[]).includes(name)) {
    return { ok: false, code: 'name-not-approved' }
  }
  return {
    ok: true,
    reference: { project, config, name: name as ApprovedSecretReferenceName }
  }
}

export function classifyAgentEnvSecretReferences(
  env: Readonly<Record<string, string>>
): AgentEnvSecretReferenceClassification {
  const entries: { readonly key: string; readonly reference: SecretReference }[] = []
  const invalidKeys: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretReferenceCandidate(value)) {
      continue
    }
    const validation = validateSecretReference(key, value)
    if (validation.ok) {
      entries.push({ key, reference: validation.reference })
    } else {
      invalidKeys.push(key)
    }
  }
  if (invalidKeys.length > 0) {
    return { kind: 'invalid', keys: invalidKeys }
  }
  return entries.length > 0 ? { kind: 'valid', entries } : { kind: 'none' }
}
