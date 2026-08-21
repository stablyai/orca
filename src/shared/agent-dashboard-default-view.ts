export type AgentDashboardView = 'map' | 'board'

/** Explicit pop-out/query overrides beat the persisted default. */
export function resolveAgentDashboardInitialView(args: {
  defaultWorktreeView?: boolean | null
  requestedView?: string | null
}): AgentDashboardView {
  const requested = args.requestedView
  if (requested === 'map' || requested === 'rings') {
    return 'map'
  }
  if (requested === 'board' || requested === 'kanban') {
    return 'board'
  }
  return args.defaultWorktreeView === true ? 'map' : 'board'
}
