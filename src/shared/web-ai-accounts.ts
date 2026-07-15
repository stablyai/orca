import type { ExecutionHostId } from './execution-host'
import type {
  BrowserCookieImportScope,
  BrowserWorkspace,
  WebAiAccount,
  WebAiProvider
} from './types'
import { getWebAiAccountWorkspaceId } from './constants'
import { normalizeBrowserCookieImportScopeForHome } from './browser-cookie-import-scope'

export {
  getWebAiAccountWorkspaceId,
  isWebAiAccountWorkspaceId,
  isWebAiBrowserWorkspaceId,
  parseWebAiAccountWorkspaceId
} from './constants'

export type WebAiProviderDefinition = {
  id: WebAiProvider
  label: string
  homeUrl: string
  hostnames: readonly string[]
  cookieDomains: readonly string[]
}

export const WEB_AI_PROVIDERS: readonly WebAiProviderDefinition[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    hostnames: ['chatgpt.com', 'chat.openai.com'],
    cookieDomains: ['chatgpt.com', 'openai.com']
  },
  {
    id: 'claude',
    label: 'Claude',
    homeUrl: 'https://claude.ai/',
    hostnames: ['claude.ai'],
    cookieDomains: ['claude.ai', 'anthropic.com']
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    homeUrl: 'https://chat.deepseek.com/',
    hostnames: ['chat.deepseek.com'],
    cookieDomains: ['deepseek.com']
  },
  {
    id: 'gemini',
    label: 'Gemini',
    homeUrl: 'https://gemini.google.com/',
    hostnames: ['gemini.google.com'],
    cookieDomains: ['google.com']
  },
  {
    id: 'aistudio',
    label: 'Google AI Studio',
    homeUrl: 'https://aistudio.google.com/',
    hostnames: ['aistudio.google.com'],
    cookieDomains: ['google.com']
  },
  {
    // Why: Custom metadata is account-owned. Empty catalog values prevent an
    // incomplete custom record from silently inheriting another service.
    id: 'custom',
    label: 'Custom',
    homeUrl: '',
    hostnames: [],
    cookieDomains: []
  }
]

const WEB_AI_PROVIDER_BY_ID = new Map(
  WEB_AI_PROVIDERS.map((provider) => [provider.id, provider] as const)
)

export function getWebAiProvider(provider: WebAiProvider): WebAiProviderDefinition {
  const definition = WEB_AI_PROVIDER_BY_ID.get(provider)
  if (!definition) {
    throw new Error(`Unknown Web AI provider: ${String(provider)}`)
  }
  return definition
}

export function isWebAiProvider(value: unknown): value is WebAiProvider {
  return typeof value === 'string' && WEB_AI_PROVIDER_BY_ID.has(value as WebAiProvider)
}

function normalizeExecutionHostId(value: unknown): ExecutionHostId | null {
  // Why: Web AI account surfaces are Electron-local in this release. Keeping
  // remote host records would create dead sidebar rows and shortcut slots.
  return value === 'local' ? value : null
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeCustomServiceLabel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const label = value.trim().replace(/\s+/g, ' ')
  return label && label.length <= 80 ? label : null
}

export function normalizeCustomWebAiHomeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2048) {
    return null
  }
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
      return null
    }
    url.search = ''
    url.hash = ''
    const normalized = url.toString()
    return normalized.length <= 2048 ? normalized : null
  } catch {
    return null
  }
}

function normalizeCustomCookieDomainInput(value: unknown): unknown[] | null {
  if (value == null) {
    return []
  }
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return null
}

export type NormalizedCustomWebAiAccountFields = {
  customServiceLabel: string
  customHomeUrl: string
  customCookieDomains: string[]
}

export function normalizeCustomWebAiAccountFields(
  value: unknown
): NormalizedCustomWebAiAccountFields | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  const customServiceLabel = normalizeCustomServiceLabel(
    candidate.customServiceLabel ?? candidate.serviceLabel ?? candidate.label
  )
  const customHomeUrl = normalizeCustomWebAiHomeUrl(candidate.customHomeUrl ?? candidate.homeUrl)
  const customCookieDomains = normalizeCustomCookieDomainInput(
    candidate.customCookieDomains ?? candidate.cookieDomains
  )
  if (!customServiceLabel || !customHomeUrl || !customCookieDomains) {
    return null
  }
  const scope = normalizeBrowserCookieImportScopeForHome(
    { label: customServiceLabel, domains: customCookieDomains },
    customHomeUrl
  )
  if (!scope) {
    return null
  }
  return {
    customServiceLabel: scope.label,
    customHomeUrl,
    customCookieDomains: scope.domains
  }
}

export function getWebAiAccountServiceLabel(account: WebAiAccount): string {
  if (account.provider === 'custom') {
    return normalizeCustomServiceLabel(account.customServiceLabel) ?? account.label
  }
  return getWebAiProvider(account.provider).label
}

export function getWebAiAccountHomeUrl(account: WebAiAccount): string | null {
  if (account.provider === 'custom') {
    return normalizeCustomWebAiHomeUrl(account.customHomeUrl)
  }
  return getWebAiProvider(account.provider).homeUrl
}

export function getWebAiAccountCookieImportScope(
  account: WebAiAccount
): BrowserCookieImportScope | null {
  if (account.provider !== 'custom') {
    return null
  }
  const customFields = normalizeCustomWebAiAccountFields(account)
  if (!customFields) {
    return null
  }
  return normalizeBrowserCookieImportScopeForHome(
    {
      label: customFields.customServiceLabel,
      domains: customFields.customCookieDomains
    },
    customFields.customHomeUrl
  )
}

export function normalizeWebAiAccount(value: unknown): WebAiAccount | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  const id = normalizeOptionalString(candidate.id)
  const label = normalizeOptionalString(candidate.label)
  const profileId = normalizeOptionalString(candidate.profileId)
  const sessionPartition = normalizeOptionalString(candidate.sessionPartition)
  const executionHostId = normalizeExecutionHostId(candidate.executionHostId ?? 'local')
  if (!id || !label || !profileId || !sessionPartition || !executionHostId) {
    return null
  }
  if (!isWebAiProvider(candidate.provider)) {
    return null
  }
  const createdAt =
    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
      ? candidate.createdAt
      : 0
  const account: WebAiAccount = {
    id,
    provider: candidate.provider,
    label: label.slice(0, 80),
    executionHostId,
    profileId,
    sessionPartition,
    createdAt
  }
  if (candidate.provider !== 'custom') {
    return account
  }
  const customFields = normalizeCustomWebAiAccountFields(candidate)
  return customFields ? { ...account, ...customFields } : null
}

export function normalizeWebAiAccounts(value: unknown): WebAiAccount[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seenIds = new Set<string>()
  const accounts: WebAiAccount[] = []
  for (const entry of value) {
    const account = normalizeWebAiAccount(entry)
    if (!account || seenIds.has(account.id)) {
      continue
    }
    seenIds.add(account.id)
    accounts.push(account)
  }
  return accounts
}

export function webAiAccountMatchesWorkspace(
  account: WebAiAccount,
  workspace: Pick<
    BrowserWorkspace,
    'worktreeId' | 'sessionProfileId' | 'sessionPartition' | 'webAiAccountId'
  >,
  browserWorkspaceId = getWebAiAccountWorkspaceId(account.id)
): boolean {
  return (
    account.executionHostId === 'local' &&
    workspace.worktreeId === browserWorkspaceId &&
    workspace.webAiAccountId === account.id &&
    workspace.sessionProfileId === account.profileId &&
    workspace.sessionPartition === account.sessionPartition
  )
}
