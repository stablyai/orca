import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { callRuntimeResult } from './web-runtime-calls'
import { fetchAccountsSnapshot } from './web-rate-limits-api'

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
  // Cursor auth is host-owned and unreadable here; claiming signed-out would contradict the host-provided usage meter.
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

// Why: select/remove await provider usage refreshes on the server; give an applied switch room.
const ACCOUNT_MUTATION_TIMEOUT_MS = 30_000

function rejectHostOnlySignIn(): Promise<never> {
  return Promise.reject(
    new Error(
      translate(
        'auto.components.web.preloadApi.accounts.signInHostOnly',
        'Adding or re-signing an account is only available in the desktop app on the computer running Orca.'
      )
    )
  )
}

// Paired server owns accounts; list/select/remove use accounts.* RPCs, while sign-in requires the host login flow.
export function createClaudeAccountsApi(): PreloadApi['claudeAccounts'] {
  return {
    list: async () => (await fetchAccountsSnapshot(false)).claude,
    add: rejectHostOnlySignIn,
    cancelPendingLogin: () => Promise.resolve(false),
    reauthenticate: rejectHostOnlySignIn,
    waitForSignInLink: () => Promise.resolve(null),
    remove: ({ accountId }) =>
      callRuntimeResult<ClaudeRateLimitAccountsState>(
        'accounts.removeClaude',
        { accountId },
        ACCOUNT_MUTATION_TIMEOUT_MS
      ),
    select: ({ accountId, runtime }) => {
      // No targeted Claude select RPC; null would clear host lane, while concrete account IDs identify their lane.
      if (runtime === 'wsl' && accountId === null) {
        return Promise.reject(
          new Error(
            translate(
              'auto.components.web.preloadApi.accounts.claudeWslDefaultUnavailable',
              'Switching a WSL lane back to the system default is only available in the desktop app.'
            )
          )
        )
      }
      return callRuntimeResult<ClaudeRateLimitAccountsState>(
        'accounts.selectClaude',
        { accountId },
        ACCOUNT_MUTATION_TIMEOUT_MS
      )
    }
  }
}

export function createCodexAccountsApi(): PreloadApi['codexAccounts'] {
  return {
    list: async () => (await fetchAccountsSnapshot(false)).codex,
    add: rejectHostOnlySignIn,
    cancelPendingLogin: () => Promise.resolve(false),
    // Host browser owns login; web has no pending URL or changes to publish.
    getPendingLoginUrl: () => Promise.resolve(null),
    onPendingLoginUrlChanged: () => () => {},
    reauthenticate: rejectHostOnlySignIn,
    remove: ({ accountId }) =>
      callRuntimeResult<CodexRateLimitAccountsState>(
        'accounts.removeCodex',
        { accountId },
        ACCOUNT_MUTATION_TIMEOUT_MS
      ),
    // Why: a WSL lane needs the targeted RPC, or a null selection would clear the host lane.
    select: ({ accountId, runtime, wslDistro }) =>
      runtime === 'wsl'
        ? callRuntimeResult<CodexRateLimitAccountsState>(
            'accounts.selectCodexForTarget',
            { accountId, target: { runtime: 'wsl', wslDistro: wslDistro ?? null } },
            ACCOUNT_MUTATION_TIMEOUT_MS
          )
        : callRuntimeResult<CodexRateLimitAccountsState>(
            'accounts.selectCodex',
            { accountId },
            ACCOUNT_MUTATION_TIMEOUT_MS
          ),
    // PTY host owns launch-account records; return no stale panes instead of rejecting the sweep.
    listStalePanes: () => Promise.resolve([]),
    // No web-owned lane records; empty results let every pane use derivation.
    listRecordedPaneLanes: () => Promise.resolve({}),
    forgetStalePanes: () => Promise.resolve()
  }
}
