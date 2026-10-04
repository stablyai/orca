import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { callRuntimeResult } from './web-runtime-calls'
import { fetchAccountsSnapshot, refreshAndPublishRateLimits } from './web-rate-limits-api'

export function createMiniMaxCredentialsApi(): NonNullable<
  Partial<PreloadApi>['minimaxCredentials']
> {
  // Nulls, not 'sealed': MiniMax credentials live on the desktop host, so this bridge
  // stores nothing and has no protection to claim either way.
  const notConfigured = {
    configured: false,
    cookieConfigured: false,
    apiKeyConfigured: false,
    cookieProtection: null,
    apiKeyProtection: null
  }
  const unsupportedError = new Error('MiniMax cookie storage is only available in the desktop app.')
  return {
    getStatus: () => Promise.resolve(notConfigured),
    saveCookie: () => Promise.reject(unsupportedError),
    clearCookie: () => Promise.resolve(notConfigured),
    saveApiKey: () => Promise.reject(unsupportedError),
    clearApiKey: () => Promise.resolve(notConfigured)
  }
}

export function createZcodePlanCredentialsApi(): PreloadApi['zcodePlanCredentials'] {
  const status = {
    detailsUnavailable: true,
    apiKeyConfigured: false,
    zcodeCliConfigured: false,
    apiKeyProtection: null
  }
  const unsupported = () =>
    Promise.reject(
      new Error(
        'GLM Coding Plan keys can only be changed in the desktop app on the computer running Orca.'
      )
    )
  return {
    getStatus: () => Promise.resolve(status),
    saveApiKey: unsupported,
    clearApiKey: unsupported
  }
}

export function createCursorAccountsApi(): NonNullable<Partial<PreloadApi>['cursorAccounts']> {
  // Why an explanation and not a bare `signedIn: false`: Cursor's session lives on
  // the machine running Orca, and this bridge cannot read it. The host may well be
  // signed in — its usage meter still arrives over the rate-limit snapshot — so
  // asserting "not signed in" here would contradict the meter beside it.
  return {
    getStatus: () =>
      Promise.resolve({
        signedIn: false,
        email: null,
        displayName: null,
        credentialSource: null,
        planType: null,
        tokenFresh: false,
        error: translate(
          'auto.components.web.preloadApi.cursorAccounts.hostOnly',
          'Cursor sign-in details are only readable on the computer running Orca.'
        )
      })
  }
}

export function createOpenCodeGoCredentialsApi(): PreloadApi['opencodeGoCredentials'] {
  const notConfigured = { apiKeyConfigured: false }
  return {
    getStatus: () => Promise.resolve(notConfigured),
    saveApiKey: () =>
      Promise.reject(new Error('OpenCode Go key storage is only available in the desktop app.')),
    clearApiKey: () => Promise.resolve(notConfigured)
  }
}

export function createGrokAccountsApi(): NonNullable<Partial<PreloadApi>['grokAccounts']> {
  const unsigned = {
    signedIn: false,
    email: null,
    teamId: null,
    tokenFresh: false,
    error: null
  }
  return {
    getStatus: () => Promise.resolve(unsigned)
  }
}

function createEmptyManagedAccountsState(): {
  accounts: never[]
  activeAccountId: null
  activeAccountIdsByRuntime: { host: null; wsl: Record<string, string | null> }
} {
  return {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }
}

export function createClaudeAccountsApi(): PreloadApi['claudeAccounts'] {
  const empty = createEmptyManagedAccountsState()
  // Why: the paired server owns the Claude accounts; listing, switching and
  // removing go through its accounts.* RPCs. Adding or re-authenticating needs
  // the host's own login flow, so those stay unavailable here.
  return {
    list: () =>
      fetchAccountsSnapshot(false)
        .then((snapshot) => snapshot.claude)
        .catch(() => empty),
    add: () => Promise.resolve(empty),
    cancelPendingLogin: () => Promise.resolve(false),
    reauthenticate: () => Promise.resolve(empty),
    remove: ({ accountId }) =>
      callRuntimeResult<ClaudeRateLimitAccountsState>('accounts.removeClaude', { accountId }),
    select: async ({ accountId }) => {
      const next = await callRuntimeResult<ClaudeRateLimitAccountsState>('accounts.selectClaude', {
        accountId
      })
      void refreshAndPublishRateLimits()
      return next
    }
  }
}

export function createCodexAccountsApi(): PreloadApi['codexAccounts'] {
  const empty = createEmptyManagedAccountsState()
  return {
    list: () =>
      fetchAccountsSnapshot(false)
        .then((snapshot) => snapshot.codex)
        .catch(() => empty),
    add: () => Promise.resolve(empty),
    cancelPendingLogin: () => Promise.resolve(false),
    // Why: the login runs on the desktop host that owns the browser, so a web
    // client has no link to offer and nothing to publish changes from.
    getPendingLoginUrl: () => Promise.resolve(null),
    onPendingLoginUrlChanged: () => () => {},
    reauthenticate: () => Promise.resolve(empty),
    remove: ({ accountId }) =>
      callRuntimeResult<CodexRateLimitAccountsState>('accounts.removeCodex', { accountId }),
    select: async ({ accountId }) => {
      const next = await callRuntimeResult<CodexRateLimitAccountsState>('accounts.selectCodex', {
        accountId
      })
      void refreshAndPublishRateLimits()
      return next
    },
    // Why: launch accounts are recorded on the host that owns the PTY, which the
    // web client never is — report no stale panes rather than reject the sweep.
    listStalePanes: () => Promise.resolve([]),
    // Why empty rather than absent: the same host owns both records, so a web
    // client has no recorded lane to offer and every pane falls to derivation.
    listRecordedPaneLanes: () => Promise.resolve({}),
    forgetStalePanes: () => Promise.resolve()
  }
}
