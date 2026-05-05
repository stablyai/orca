export type OpenHttpLinkOptions = {
  worktreeId?: string | null
  forceSystemBrowser?: boolean
}

type StoreAccessor = () => {
  settings?: { openLinksInApp?: boolean } | null
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
// branch). Shift+Cmd/Ctrl is the escape hatch: callers pass forceSystemBrowser
// to bypass the setting entirely.
export function openHttpLink(url: string, opts: OpenHttpLinkOptions = {}): void {
  const { worktreeId, forceSystemBrowser } = opts
  const state = storeAccessor?.()
  const routeToOrca =
    !forceSystemBrowser && Boolean(worktreeId) && state?.settings?.openLinksInApp !== false

  if (routeToOrca && worktreeId && state) {
    // Why: http clicks from inside a worktree should not push a worktree-switch
    // history entry — the user isn't changing worktrees, they're opening a tab
    // in the one they're already in. activateAndRevealWorktree is reserved for
    // file-link jumps that genuinely switch worktrees.
    state.setActiveWorktree(worktreeId)
    state.createBrowserTab(worktreeId, url, { activate: true })
    return
  }

  void window.api.shell.openUrl(url)
}
