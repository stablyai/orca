// Loads Settings › Enterprise's single sign-on and directory sync state for a team from auth, and
// runs the owner's actions: open the setup page, add, check and remove an email domain.
// The state is re-read after every action and whenever the window regains focus, so a connection
// finished in the browser, or directory sync turned on for the team, shows up without a restart.
import { useCallback, useEffect, useState } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  OrcaProfileOrgEnterpriseResult,
  OrcaProfileOrgSsoDomainResult,
  OrcaProfileOrgSsoSetupLinkResult
} from '../../../../../../shared/orca-org-enterprise'
import { useRequestGeneration } from '../../cloud-api/use-request-generation'
import { ssoDomainRefusalCopy, type SsoDomainNotice } from './EnterpriseSsoDomains'
import type { EnterpriseSsoState } from './EnterpriseSsoView'

type CommonStatus = Exclude<OrcaProfileOrgEnterpriseResult['status'], 'ok' | 'failed'>

function commonFailureCopy(status: CommonStatus | 'failed', t: Translate): string {
  switch (status) {
    case 'reconnect-required':
      return t('settings.enterprise.sso.error.signIn', 'Sign in to Orca again to see this.')
    case 'forbidden':
      return t(
        'settings.enterprise.sso.error.forbidden',
        'Only a team owner or admin can see this.'
      )
    case 'rate-limited':
      return t('settings.enterprise.sso.error.rateLimited', 'Too many requests. Try again shortly.')
    case 'unsupported':
    case 'unconfigured':
      return t(
        'settings.enterprise.sso.error.unsupported',
        'Single sign-on settings aren’t available here yet.'
      )
    case 'unavailable':
    case 'failed':
      return t(
        'settings.enterprise.sso.error.unavailable',
        'Couldn’t reach Orca Cloud. Check your connection and try again.'
      )
  }
}

export function ssoSetupLinkFailureCopy(
  status: Exclude<OrcaProfileOrgSsoSetupLinkResult['status'], 'ok'>,
  t: Translate
): string {
  if (status === 'recent-sign-in-required') {
    return t(
      'settings.enterprise.sso.error.recentSignIn',
      'For your team’s safety, sign out and sign in to Orca again, then open the setup page within 10 minutes.'
    )
  }
  if (status === 'not-entitled') {
    return t(
      'settings.enterprise.sso.error.notEntitled',
      'Your team’s plan doesn’t include changing single sign-on.'
    )
  }
  if (status === 'forbidden') {
    return t('settings.enterprise.sso.ownersOnly', 'Only a team owner can change single sign-on.')
  }
  return commonFailureCopy(status, t)
}

export function useEnterpriseSso(
  orgId: string | null,
  enabled: boolean
): {
  state: EnterpriseSsoState
  now: number
  setupNotice: string | null
  domainBusy: string | null
  domainNotice: SsoDomainNotice | null
  retry: () => void
  /** Mints a setup link; null (after setting setupNotice) when there is none. */
  mintSetupLink: () => Promise<string | null>
  openSetup: () => void
  addDomain: (domain: string) => void
  verifyDomain: (domain: string) => void
  removeDomain: (domain: string) => void
} {
  const t = useTranslate()
  const api = window.api.orcaProfiles
  const begin = useRequestGeneration()
  const [state, setState] = useState<EnterpriseSsoState>({ status: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const [setupNotice, setSetupNotice] = useState<string | null>(null)
  const [domainBusy, setDomainBusy] = useState<string | null>(null)
  const [domainNotice, setDomainNotice] = useState<SsoDomainNotice | null>(null)

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (!orgId || !enabled) {
        return
      }
      const isCurrent = begin('enterprise-sso')
      if (!quiet) {
        setState({ status: 'loading' })
      }
      const result = await api
        .orgEnterprise({ orgId })
        .catch((): OrcaProfileOrgEnterpriseResult => ({ status: 'unavailable' }))
      if (!isCurrent()) {
        return
      }
      setNow(Date.now())
      if (result.status === 'ok') {
        setState({ status: 'ok', enterprise: result.enterprise })
        return
      }
      // A quiet refresh that fails keeps what is on screen.
      setState((current) =>
        quiet && current.status === 'ok'
          ? current
          : { status: 'error', message: commonFailureCopy(result.status, t) }
      )
    },
    [api, begin, enabled, orgId, t]
  )

  useEffect(() => {
    void load(false)
  }, [load])

  useEffect(() => {
    const onFocus = (): void => void load(true)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const mintSetupLink = useCallback(async (): Promise<string | null> => {
    if (!orgId) {
      return null
    }
    setSetupNotice(null)
    const result = await api
      .orgSsoSetupLink({ orgId })
      .catch((): OrcaProfileOrgSsoSetupLinkResult => ({ status: 'unavailable' }))
    if (result.status === 'ok') {
      // The team may now set a connection up: reflect it.
      void load(true)
      return result.url
    }
    setSetupNotice(ssoSetupLinkFailureCopy(result.status, t))
    return null
  }, [api, load, orgId, t])

  const openSetup = useCallback((): void => {
    void mintSetupLink().then((url) => {
      if (url) {
        void window.api.shell.openUrl(url)
      }
    })
  }, [mintSetupLink])

  const changeDomain = useCallback(
    async (action: 'add' | 'verify' | 'remove', domain: string): Promise<void> => {
      if (!orgId) {
        return
      }
      setDomainBusy(action === 'add' ? '' : domain)
      setDomainNotice(null)
      const call =
        action === 'add'
          ? api.orgSsoDomainAdd
          : action === 'verify'
            ? api.orgSsoDomainVerify
            : api.orgSsoDomainRemove
      const result = await call({ orgId, domain }).catch((): OrcaProfileOrgSsoDomainResult => ({
        status: 'unavailable'
      }))
      setDomainBusy(null)
      if (result.status === 'refused') {
        setDomainNotice({
          domain: action === 'add' ? null : domain,
          message: ssoDomainRefusalCopy(result.reason, t)
        })
      } else if (result.status !== 'ok') {
        setDomainNotice({
          domain: action === 'add' ? null : domain,
          message:
            result.status === 'not-entitled'
              ? ssoSetupLinkFailureCopy('not-entitled', t)
              : commonFailureCopy(result.status, t)
        })
      }
      await load(true)
    },
    [api, load, orgId, t]
  )

  return {
    state,
    now,
    setupNotice,
    domainBusy,
    domainNotice,
    retry: () => void load(false),
    mintSetupLink,
    openSetup,
    addDomain: (domain) => void changeDomain('add', domain),
    verifyDomain: (domain) => void changeDomain('verify', domain),
    removeDomain: (domain) => void changeDomain('remove', domain)
  }
}
