// Why: these local RPC methods can spend longer than the transport idle window
// in I/O-bound work, so the connection needs liveness frames while they run.
export const SLOW_DISPATCH_METHODS: ReadonlySet<string> = new Set([
  'worktree.create',
  'browser.tabCreate',
  'browser.snapshot'
])

export const SLOW_DISPATCH_MUTATION_METHODS: ReadonlySet<string> = new Set([
  'worktree.create',
  'browser.tabCreate'
])

export function isSlowDispatchMethod(method: string): boolean {
  return SLOW_DISPATCH_METHODS.has(method)
}

export function isSlowDispatchMutationMethod(method: string): boolean {
  return SLOW_DISPATCH_MUTATION_METHODS.has(method)
}
