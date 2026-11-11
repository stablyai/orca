import type { PreloadApi } from '../../../../preload/api-types'

// Machine error code callers match on (never shown); the copy comes from describeError().
const NOT_CONFIGURED_CODE = 'not_configured'
const NOT_CONFIGURED = { ok: false as const, error: NOT_CONFIGURED_CODE }

/** The web client has no Orca Cloud control-plane session; team workspaces stay desktop-only here. */
export function createWebCloudWorkspacesApi(): PreloadApi['cloudWorkspaces'] {
  return {
    available: () => Promise.resolve(false),
    list: () => Promise.resolve(NOT_CONFIGURED),
    get: () => Promise.resolve(NOT_CONFIGURED),
    patch: () => Promise.resolve(NOT_CONFIGURED),
    resolveLink: () => Promise.resolve(NOT_CONFIGURED),
    openGrant: () => Promise.resolve(NOT_CONFIGURED),
    readSnapshot: () => Promise.resolve(NOT_CONFIGURED),
    listGrants: () => Promise.resolve(NOT_CONFIGURED),
    revokeGrant: () => Promise.resolve(NOT_CONFIGURED),
    sleep: () => Promise.resolve(NOT_CONFIGURED),
    destroy: () => Promise.resolve(NOT_CONFIGURED),
    localWorkspaces: () => Promise.resolve([]),
    noteSent: () => Promise.resolve(),
    bindEnvironment: () => Promise.resolve(),
    environmentBindings: () => Promise.resolve({}),
    setActive: () => Promise.resolve(),
    getOrgPrompts: () => Promise.resolve(NOT_CONFIGURED),
    putOrgPrompts: () => Promise.resolve(NOT_CONFIGURED),
    getPrefs: () => Promise.resolve(NOT_CONFIGURED),
    putPrefs: () => Promise.resolve(NOT_CONFIGURED),
    getOrgSlug: () => Promise.resolve(NOT_CONFIGURED),
    teammateProfile: () => Promise.resolve(NOT_CONFIGURED),
    poke: () => Promise.resolve(NOT_CONFIGURED),
    pokeInbox: () => Promise.resolve(NOT_CONFIGURED),
    setPokesEnabled: () => Promise.resolve(NOT_CONFIGURED),
    markPokesSeen: () => Promise.resolve(NOT_CONFIGURED),
    onOpenLink: () => () => {},
    consumePendingLink: () => Promise.resolve(null)
  }
}
