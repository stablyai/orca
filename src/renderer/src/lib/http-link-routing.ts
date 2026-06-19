import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export type OpenHttpLinkOptions = {
  worktreeId?: string | null
  forceSystemBrowser?: boolean
  routeMode?: TerminalHttpRouteMode
  runtimeEnvironmentId?: string | null
  connectionId?: string | null
}

export type TerminalHttpRouteMode =
  | 'default'
  | 'force-system'
  | 'force-orca-if-supported'
  | 'alternate'

type StoreAccessor = () => {
  settings?: { openLinksInApp?: boolean; activeRuntimeEnvironmentId?: string | null } | null
  setActiveWorktree: (worktreeId: string) => void
  createBrowserTab: (worktreeId: string, url: string, opts: { activate: boolean }) => unknown
}

// Why: store access is injected via registerHttpLinkStoreAccessor rather than
// a direct `import '@/store'` to avoid a circular import — store/slices/editor.ts
// imports this module, and '@/store' transitively imports editor.ts. Without
// the break, several renderer test files that load this module first see
// `createEditorSlice` as undefined at store/index.ts initialization.
let storeAccessor: StoreAccessor | null = null

export function registerHttpLinkStoreAccessor(fn: StoreAccessor): void {
  storeAccessor = fn
}

// Scope: http(s) URLs only. file: URIs and in-worktree markdown targets are
// owned by resolveMarkdownLinkTarget and must stay on that path — this helper
// is only invoked on target.kind === 'external' (and for the terminal's http
function hasValue(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

// Why: terminal connection lookups return undefined while store metadata is
// still hydrating; treating that as local can route restored SSH links locally.
function hasKnownLocalConnection(opts: Pick<OpenHttpLinkOptions, 'connectionId'>): boolean {
  if (!Object.prototype.hasOwnProperty.call(opts, 'connectionId')) {
    return true
  }
  return opts.connectionId !== undefined && !hasValue(opts.connectionId)
}

export function canRouteHttpLinkToOrcaBrowser(
  opts: Pick<OpenHttpLinkOptions, 'worktreeId' | 'runtimeEnvironmentId' | 'connectionId'>,
  activeRuntimeEnvironmentId?: string | null
): boolean {
  return (
    Boolean(opts.worktreeId) &&
    !hasValue(activeRuntimeEnvironmentId) &&
    !hasValue(opts.runtimeEnvironmentId) &&
    hasKnownLocalConnection(opts)
  )
}

function resolveHttpRouteMode(
  mode: TerminalHttpRouteMode,
  openLinksInApp: boolean | undefined
): Exclude<TerminalHttpRouteMode, 'alternate'> {
  if (mode === 'alternate') {
    return openLinksInApp === true ? 'force-system' : 'force-orca-if-supported'
  }
  return mode
}

// branch). Explicit route modes let terminal links request a one-click route
// without changing the persisted Link Routing default.
export function openHttpLink(url: string, opts: OpenHttpLinkOptions = {}): void {
  const { worktreeId, forceSystemBrowser } = opts
  const state = storeAccessor?.()
  const settings = state?.settings
  const routeMode = resolveHttpRouteMode(
    forceSystemBrowser ? 'force-system' : (opts.routeMode ?? 'default'),
    settings?.openLinksInApp
  )
  const orcaSupported = canRouteHttpLinkToOrcaBrowser(opts, settings?.activeRuntimeEnvironmentId)
  const routeToOrca =
    Boolean(settings) &&
    orcaSupported &&
    (routeMode === 'force-orca-if-supported' ||
      (routeMode === 'default' && settings?.openLinksInApp === true))

  if (routeToOrca && worktreeId && state) {
    // Why: http clicks from inside a worktree should not push a worktree-switch
    // history entry — the user isn't changing worktrees, they're opening a tab
    // in the one they're already in. activateAndRevealWorktree is reserved for
    // file-link jumps that genuinely switch worktrees.
    if (worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
      // Why: the floating workspace uses a synthetic worktree id. Promoting it
      // to the global activeWorktreeId deselects the real repo workspace.
      state.setActiveWorktree(worktreeId)
    }
    state.createBrowserTab(worktreeId, url, { activate: true })
    return
  }

  void window.api.shell.openUrl(url)
}
