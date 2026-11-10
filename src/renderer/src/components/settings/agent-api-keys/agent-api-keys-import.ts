import type {
  AgentApiKeysImportResult,
  AgentApiKeysScanResult,
  LocalAgentKeySource,
  LocalAgentSignInFound
} from '../../../../../shared/agent-api-keys/agent-api-key-cloud'
import type { Translate } from '@/i18n/use-translate'

export type ImportScanState =
  | { kind: 'scanning' }
  | { kind: 'failed' }
  | { kind: 'ready'; scan: AgentApiKeysScanResult }

/** Every key found that the vault doesn't already hold starts checked. */
export function defaultImportSelection(scan: AgentApiKeysScanResult): string[] {
  return scan.keys.filter((key) => !key.alreadySaved).map((key) => key.name)
}

export function importSourceLabel(source: LocalAgentKeySource, t: Translate): string {
  switch (source) {
    case 'opencode-auth':
      return t('agentApiKeys.import.source.opencode', 'OpenCode sign-in file')
    case 'gemini-env-file':
      return t('agentApiKeys.import.source.geminiEnv', '~/.gemini/.env')
    case 'shell-env':
      return t('agentApiKeys.import.source.shell', 'Shell environment')
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'github-copilot': 'GitHub Copilot'
}

export function signInProviderLabel(signIn: LocalAgentSignInFound): string {
  return PROVIDER_LABELS[signIn.provider] ?? signIn.provider
}

/** What to tell the user after an import: how many landed, and every name that didn't fully. */
export function importOutcome(
  result: Pick<AgentApiKeysImportResult, 'imported' | 'failed' | 'cloudFailed'>,
  t: Translate
): { imported: number; failure: string | null } {
  const problems = [
    ...result.failed.map((entry) => `${entry.name}: ${entry.error}`),
    ...result.cloudFailed.map((entry) =>
      t(
        'agentApiKeys.import.cloudFailed',
        '{{name}} is saved on this computer, but not in your Orca account.',
        { name: entry.name }
      )
    )
  ]
  return {
    imported: result.imported.length,
    failure: problems.length > 0 ? problems.join(' ') : null
  }
}
