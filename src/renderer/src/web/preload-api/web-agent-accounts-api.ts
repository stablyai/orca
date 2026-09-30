import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'

export function createMiniMaxCredentialsApi(): NonNullable<
  Partial<PreloadApi>['minimaxCredentials']
> {
  const notConfigured = { configured: false, cookieConfigured: false, apiKeyConfigured: false }
  const unsupportedError = new Error('MiniMax cookie storage is only available in the desktop app.')
  return {
    getStatus: () => Promise.resolve(notConfigured),
    saveCookie: () => Promise.reject(unsupportedError),
    clearCookie: () => Promise.resolve(notConfigured),
    saveApiKey: () => Promise.reject(unsupportedError),
    clearApiKey: () => Promise.resolve(notConfigured)
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
  return {
    list: () => Promise.resolve(empty),
    add: () => Promise.resolve(empty),
    cancelPendingLogin: () => Promise.resolve(false),
    reauthenticate: () => Promise.resolve(empty),
    remove: () => Promise.resolve(empty),
    select: () => Promise.resolve(empty)
  }
}

export function createCodexAccountsApi(): PreloadApi['codexAccounts'] {
  const empty = createEmptyManagedAccountsState()
  return {
    list: () => Promise.resolve(empty),
    add: () => Promise.resolve(empty),
    cancelPendingLogin: () => Promise.resolve(false),
    // Why: the login runs on the desktop host that owns the browser, so a web
    // client has no link to offer and nothing to publish changes from.
    getPendingLoginUrl: () => Promise.resolve(null),
    onPendingLoginUrlChanged: () => () => {},
    reauthenticate: () => Promise.resolve(empty),
    remove: () => Promise.resolve(empty),
    select: () => Promise.resolve(empty),
    // Why: launch accounts are recorded on the host that owns the PTY, which the
    // web client never is — report no stale panes rather than reject the sweep.
    listStalePanes: () => Promise.resolve([]),
    // Why empty rather than absent: the same host owns both records, so a web
    // client has no recorded lane to offer and every pane falls to derivation.
    listRecordedPaneLanes: () => Promise.resolve({}),
    forgetStalePanes: () => Promise.resolve()
  }
}
