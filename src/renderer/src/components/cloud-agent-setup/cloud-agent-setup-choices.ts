import { cloudSecretValueError } from '../../../../shared/cloud-secrets/cloud-secret-rules'
import type { CloudSecretsErrorCode } from '../../../../shared/cloud-secrets/cloud-secrets-wire'

export type CloudAgentSetupOption = 'sign-in' | 'api-key' | 'gateway' | 'custom'
export type CloudAgentSetupScope = 'personal' | 'org'
export type CloudAgentSetupFailure = { error: CloudSecretsErrorCode; field?: string }

/** Each preset is just secrets: the control plane derives base URLs and tokens for the VM. */
export type CloudAgentSetupChoice =
  | { kind: 'api-key'; provider: 'anthropic' | 'openai'; key: string }
  | { kind: 'gateway'; key: string; model: string; codexModel: string }
  | { kind: 'custom'; baseUrl: string; token: string; model: string }

export type CloudAgentSetupWrite = {
  set: Record<string, string>
  /** Which field each variable came from, so a server refusal lands on the right input. */
  field: Record<string, string>
}

export function cloudAgentSetupWrite(choice: CloudAgentSetupChoice): CloudAgentSetupWrite {
  switch (choice.kind) {
    case 'api-key': {
      const name = choice.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
      return { set: { [name]: choice.key.trim() }, field: { [name]: 'key' } }
    }
    case 'gateway': {
      const model = choice.model.trim()
      const codexModel = choice.codexModel.trim()
      return {
        set: {
          AI_GATEWAY_API_KEY: choice.key.trim(),
          ...(model ? { ANTHROPIC_MODEL: model } : {}),
          ...(codexModel ? { OPENAI_MODEL: codexModel } : {})
        },
        field: { AI_GATEWAY_API_KEY: 'key', ANTHROPIC_MODEL: 'model', OPENAI_MODEL: 'codexModel' }
      }
    }
    case 'custom': {
      const model = choice.model.trim()
      return {
        set: {
          ANTHROPIC_BASE_URL: choice.baseUrl.trim(),
          ANTHROPIC_AUTH_TOKEN: choice.token.trim(),
          ...(model ? { ANTHROPIC_MODEL: model } : {})
        },
        field: {
          ANTHROPIC_BASE_URL: 'baseUrl',
          ANTHROPIC_AUTH_TOKEN: 'token',
          ANTHROPIC_MODEL: 'model'
        }
      }
    }
  }
}

/** The first local problem, with the field it belongs to, before anything is sent. */
export function cloudAgentSetupProblem(
  write: CloudAgentSetupWrite
): { field: string; error: CloudSecretsErrorCode } | null {
  for (const [name, value] of Object.entries(write.set)) {
    const error = cloudSecretValueError(name, value)
    if (error) {
      return { field: write.field[name] ?? 'key', error }
    }
  }
  return null
}
