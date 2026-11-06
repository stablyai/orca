/** Ollama cloud usage: provider identity, credential status shape, and key-source doc. https://ollama.com/settings/keys */
import type { SecretAtRestProtection } from './secret-at-rest-protection'

/** Single cloud site: the shared endpoint all key holders use. */
export type OllamaCloudCredentialsStatus = {
  detailsUnavailable?: boolean
  apiKeyConfigured: boolean
  apiKeyProtection: SecretAtRestProtection | null
  /** Set when the saved file cannot be used here; 'sealed-elsewhere' means another Orca app on that machine saved it. */
  apiKeyUnreadable?: 'sealed-elsewhere' | 'unreadable'
}

/** Usage endpoint base; Ollama publishes cloud usage only at ollama.com, never via http://localhost:11434. */
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'
