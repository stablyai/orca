import {
  AI_VAULT_SEARCH_SCOPE_STORAGE_KEY,
  DEFAULT_AI_VAULT_SEARCH_SCOPE,
  normalizeAiVaultSearchScope,
  type AiVaultSearchScope
} from '../../../../shared/ai-vault-session-search-scope'

export function readStoredAiVaultSearchScope(): AiVaultSearchScope {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_AI_VAULT_SEARCH_SCOPE
  }
  try {
    return normalizeAiVaultSearchScope(localStorage.getItem(AI_VAULT_SEARCH_SCOPE_STORAGE_KEY))
  } catch {
    return DEFAULT_AI_VAULT_SEARCH_SCOPE
  }
}

export function persistAiVaultSearchScope(searchScope: AiVaultSearchScope): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(AI_VAULT_SEARCH_SCOPE_STORAGE_KEY, searchScope)
  } catch {
    // Why: search still works if quota or privacy mode blocks persistence.
  }
}
