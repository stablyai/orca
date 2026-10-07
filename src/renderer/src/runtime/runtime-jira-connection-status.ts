import type {
  JiraAuthType,
  JiraConnectionStatus,
  JiraSite,
  JiraViewer
} from '../../../shared/jira-types'
import type { SecretAtRestProtection } from '../../../shared/secret-at-rest-protection'

// Coverage records: tsc fails when the shared union gains or loses an arm.
const JIRA_AUTH_TYPES = { cloud: true, server: true } as const satisfies Readonly<
  Record<JiraAuthType, true>
>
const SECRET_AT_REST_PROTECTIONS = { sealed: true, plaintext: true } as const satisfies Readonly<
  Record<SecretAtRestProtection, true>
>

// Every key of the status, site and viewer must be listed, so a newly added field cannot be dropped silently.
type EveryKey<T> = { [K in keyof Required<T>]: T[K] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJiraAuthType(value: unknown): value is JiraAuthType {
  return typeof value === 'string' && Object.hasOwn(JIRA_AUTH_TYPES, value)
}

function isSecretAtRestProtection(value: unknown): value is SecretAtRestProtection {
  return typeof value === 'string' && Object.hasOwn(SECRET_AT_REST_PROTECTIONS, value)
}

function parseJiraViewer(value: unknown): JiraViewer | null {
  if (
    !isRecord(value) ||
    typeof value.accountId !== 'string' ||
    typeof value.displayName !== 'string'
  ) {
    return null
  }
  const viewer: EveryKey<JiraViewer> = {
    accountId: value.accountId,
    displayName: value.displayName,
    email: typeof value.email === 'string' || value.email === null ? value.email : null,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : undefined
  }
  return viewer
}

function parseJiraSite(value: unknown): JiraSite | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.siteUrl !== 'string' ||
    typeof value.displayName !== 'string' ||
    typeof value.accountId !== 'string'
  ) {
    return null
  }
  const site: EveryKey<JiraSite> = {
    id: value.id,
    siteUrl: value.siteUrl,
    email: typeof value.email === 'string' ? value.email : '',
    displayName: value.displayName,
    accountId: value.accountId,
    authType: isJiraAuthType(value.authType) ? value.authType : undefined
  }
  return site
}

function parseJiraSites(value: unknown): JiraSite[] | undefined {
  return Array.isArray(value)
    ? value.flatMap((site) => {
        const parsed = parseJiraSite(site)
        return parsed ? [parsed] : []
      })
    : undefined
}

function parseOptionalSiteId(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined
}

// Why: a missing reply (the paired web client's fallback) or a malformed nested field from another host version must not crash readers or hide a real connection.
export function parseJiraConnectionStatus(value: unknown): JiraConnectionStatus {
  if (!isRecord(value) || typeof value.connected !== 'boolean') {
    return { connected: false, viewer: null }
  }
  const status: EveryKey<JiraConnectionStatus> = {
    connected: value.connected,
    viewer: parseJiraViewer(value.viewer),
    sites: parseJiraSites(value.sites),
    activeSiteId: parseOptionalSiteId(value.activeSiteId),
    selectedSiteId: parseOptionalSiteId(value.selectedSiteId),
    credentialError: typeof value.credentialError === 'string' ? value.credentialError : undefined,
    credentialProtection:
      value.credentialProtection === null || isSecretAtRestProtection(value.credentialProtection)
        ? value.credentialProtection
        : undefined
  }
  return status
}
