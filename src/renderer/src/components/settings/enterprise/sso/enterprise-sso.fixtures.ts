// Sample single sign-on and directory sync states for the fixtures and the view test.
import type { OrcaOrgEnterprise } from '../../../../../../shared/orca-org-enterprise'
import type { EnterpriseSsoState, EnterpriseSsoViewProps } from './EnterpriseSsoView'

export const SSO_FIXTURE_NOW = Date.UTC(2026, 10, 12, 18, 0, 0)

const RECORD = {
  type: 'TXT' as const,
  name: '_orca-verify.acme.com',
  value: 'orca-verify=Qx7mB2nK9pLwT4vR8sYd1cHf6gJz3aEu'
}

/** A team on Enterprise that has not started: the owner sees Set up SSO. */
export function fixtureEnterprise(
  overrides: {
    canManage?: boolean
    sso?: Partial<OrcaOrgEnterprise['sso']>
    scim?: Partial<OrcaOrgEnterprise['scim']>
  } = {}
): OrcaOrgEnterprise {
  return {
    canManage: overrides.canManage ?? true,
    sso: {
      entitled: true,
      status: 'off',
      idp: null,
      required: false,
      sessionsEndAt: null,
      ownerSignedInWithSso: false,
      domains: [],
      ...overrides.sso
    },
    scim: {
      available: false,
      status: 'unavailable',
      lastChangeAt: null,
      lastChangeType: null,
      setupUrl: null,
      ...overrides.scim
    }
  }
}

export const LIVE_SSO: Partial<OrcaOrgEnterprise['sso']> = {
  status: 'live',
  idp: 'Okta',
  required: true,
  ownerSignedInWithSso: true,
  domains: [{ domain: 'acme.com', status: 'verified', record: RECORD }]
}

export const PENDING_DOMAIN = { domain: 'acme.com', status: 'pending' as const, record: RECORD }
export const MISSING_DOMAIN = {
  domain: 'acme.io',
  status: 'record_missing' as const,
  record: { ...RECORD, name: '_orca-verify.acme.io' }
}

export const SCIM_SETUP_URL = 'https://auth.onorca.dev/org/settings/acme'

export function fixtureSsoProps(
  state: EnterpriseSsoState,
  overrides: Partial<EnterpriseSsoViewProps> = {}
): EnterpriseSsoViewProps {
  return {
    state,
    contact: { planName: 'Enterprise', contactUrl: 'https://orca.dev/enterprise' },
    now: SSO_FIXTURE_NOW,
    setupNotice: null,
    setupLink: async () => 'https://auth.onorca.dev/saml/setup/example',
    onOpenSetup: () => {},
    onOpenUrl: () => {},
    onContactSales: () => {},
    onRetry: () => {},
    domains: {
      busy: null,
      notice: null,
      onAdd: () => {},
      onVerify: () => {},
      onRemove: () => {},
      onCopy: () => {}
    },
    ...overrides
  }
}

export const ok = (enterprise: OrcaOrgEnterprise): EnterpriseSsoState => ({
  status: 'ok',
  enterprise
})
