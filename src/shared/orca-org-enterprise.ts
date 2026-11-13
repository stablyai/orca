// Settings › Enterprise for a team: single sign-on (SAML) and directory sync (SCIM).
// Auth's GET /v1/desktop/orgs/:orgId/enterprise answers everything the pane shows; the desktop
// keeps no state of its own. That is deliberate: turning directory sync on for a customer is a
// server-side change (the plan, the identity provider), never a desktop release. So `scim` is
// shown exactly when the server says `available`, and for no other reason.

import { isPlainRecord } from './orca-org-delete'

/** `allowed`: may set a connection up, has none. `test`: configured, not live yet. */
export type OrcaOrgSsoStatus = 'off' | 'allowed' | 'test' | 'live'

export type OrcaOrgSsoDomainStatus = 'pending' | 'verified' | 'record_missing'

export type OrcaOrgSsoDomain = {
  domain: string
  status: OrcaOrgSsoDomainStatus
  /** The DNS record the team publishes to prove it owns the domain. */
  record: { type: 'TXT'; name: string; value: string }
}

/**
 * `needs_sso`: single sign-on must be on first. `not_enabled`: Orca has not turned directory sync
 * on for this team yet. `waiting`: on, no change received from the directory yet.
 */
export type OrcaOrgScimStatus = 'unavailable' | 'needs_sso' | 'not_enabled' | 'waiting' | 'active'

export type OrcaOrgEnterprise = {
  /** Owners set single sign-on up and change it; admins only see it. */
  canManage: boolean
  sso: {
    /** The team's plan includes single sign-on. */
    entitled: boolean
    status: OrcaOrgSsoStatus
    /** The identity provider's product name ("Okta"), when auth knows it. */
    idp: string | null
    /** Every member must sign in with SSO. True exactly while the connection is live. */
    required: boolean
    /** When sign-ins made before SSO went live end; null when nothing is pending. */
    sessionsEndAt: number | null
    /** Until an owner has signed in with SSO, owners can still sign in another way. */
    ownerSignedInWithSso: boolean
    domains: OrcaOrgSsoDomain[]
  }
  scim: {
    /** False: the pane shows no directory sync at all. Only the server turns this on. */
    available: boolean
    status: OrcaOrgScimStatus
    /** The last change received from the team's directory, and what it was. */
    lastChangeAt: number | null
    lastChangeType: string | null
    /** The identity provider page where the team's admin gets the SCIM address and key. */
    setupUrl: string | null
  }
}

const SSO_STATUSES: readonly OrcaOrgSsoStatus[] = ['off', 'allowed', 'test', 'live']
const DOMAIN_STATUSES: readonly OrcaOrgSsoDomainStatus[] = ['pending', 'verified', 'record_missing']
const SCIM_STATUSES: readonly OrcaOrgScimStatus[] = [
  'unavailable',
  'needs_sso',
  'not_enabled',
  'waiting',
  'active'
]

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Only https links are ever opened or copied from this answer. */
function httpsUrl(value: unknown): string | null {
  const raw = text(value, 2048)
  if (!raw) {
    return null
  }
  try {
    return new URL(raw).protocol === 'https:' ? raw : null
  } catch {
    return null
  }
}

export function normalizeOrgSsoDomain(value: unknown): OrcaOrgSsoDomain | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.record)) {
    return null
  }
  const domain = text(value.domain, 253)
  const name = text(value.record.name, 300)
  const recordValue = text(value.record.value, 300)
  const status = DOMAIN_STATUSES.find((candidate) => candidate === value.status)
  if (!domain || !name || !recordValue || !status) {
    return null
  }
  return { domain, status, record: { type: 'TXT', name, value: recordValue } }
}

/**
 * Reads auth's answer leniently: a missing or malformed part reads as the locked, off state, never
 * as something being on. In particular directory sync is available only on a literal `true`.
 */
export function normalizeOrgEnterprise(value: unknown): OrcaOrgEnterprise {
  const body = isPlainRecord(value) ? value : {}
  const sso = isPlainRecord(body.sso) ? body.sso : {}
  const scim = isPlainRecord(body.scim) ? body.scim : {}
  const status = SSO_STATUSES.find((candidate) => candidate === sso.status) ?? 'off'
  const available = scim.available === true
  const scimStatus = SCIM_STATUSES.find((candidate) => candidate === scim.status) ?? 'unavailable'
  return {
    canManage: body.canManage === true,
    sso: {
      entitled: sso.entitled === true,
      status,
      idp: text(sso.idp, 64),
      required: sso.required === true,
      sessionsEndAt: time(sso.sessionsEndAt),
      ownerSignedInWithSso: sso.ownerSignedInWithSso === true,
      domains: Array.isArray(sso.domains)
        ? sso.domains
            .map(normalizeOrgSsoDomain)
            .filter((domain): domain is OrcaOrgSsoDomain => domain !== null)
        : []
    },
    scim: {
      available,
      status: available ? scimStatus : 'unavailable',
      lastChangeAt: available ? time(scim.lastChangeAt) : null,
      lastChangeType: available ? text(scim.lastChangeType, 64) : null,
      setupUrl: available ? httpsUrl(scim.setupUrl) : null
    }
  }
}

export type OrcaProfileOrgEnterpriseArgs = { orgId: string }
export type OrcaProfileOrgEnterpriseDomainArgs = { orgId: string; domain: string }

/** `unsupported`: this auth deployment has no Enterprise routes yet. */
type OrcaOrgEnterpriseCommonStatus =
  | 'unconfigured'
  | 'reconnect-required'
  | 'forbidden'
  | 'unsupported'
  | 'rate-limited'
  | 'unavailable'

export type OrcaProfileOrgEnterpriseResult =
  | { status: 'ok'; enterprise: OrcaOrgEnterprise }
  | { status: OrcaOrgEnterpriseCommonStatus }
  | { status: 'failed'; error: string }

/**
 * The setup link lets whoever holds it configure the team's sign-in, so auth only makes one for an
 * owner who signed in to this desktop in the last few minutes (`recent-sign-in-required`).
 */
export type OrcaProfileOrgSsoSetupLinkResult =
  | { status: 'ok'; url: string; expiresAt: number }
  | { status: 'recent-sign-in-required' }
  | { status: 'not-entitled' }
  | { status: OrcaOrgEnterpriseCommonStatus }
  | { status: 'failed'; error: string }

/** Why a domain change was refused, in the terms the pane explains. */
export type OrcaOrgSsoDomainRefusal =
  | 'invalid-domain'
  | 'public-domain'
  | 'too-many-domains'
  | 'domain-not-found'
  | 'domain-taken'
  | 'record-not-found'
  | 'dns-unavailable'

export type OrcaProfileOrgSsoDomainResult =
  /** `domain` is null after a removal. */
  | { status: 'ok'; domain: OrcaOrgSsoDomain | null }
  | { status: 'refused'; reason: OrcaOrgSsoDomainRefusal }
  | { status: 'not-entitled' }
  | { status: OrcaOrgEnterpriseCommonStatus }
  | { status: 'failed'; error: string }

export const ORCA_ORG_SSO_DOMAIN_MAX_LENGTH = 253

/**
 * A sign-in auth refused because the person's team requires single sign-on and they signed in
 * another way (callback `error=sso_required`). The connect result carries it as its `error`.
 */
export const ORCA_CLOUD_AUTH_SSO_REQUIRED_ERROR = 'orca_cloud_auth_sso_required'
