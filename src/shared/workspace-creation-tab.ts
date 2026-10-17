/**
 * The tab a workspace was created for: the first tab running the agent it was created with.
 * Derived from the saved `createdWithAgent` and each tab's own agent, so nothing extra is stored and
 * closing that tab retires the default by itself.
 */
export function findWorkspaceCreationTab<T>(
  tabs: readonly T[],
  createdWithAgent: string | undefined,
  agentOf: (tab: T) => string | undefined
): T | undefined {
  return createdWithAgent ? tabs.find((tab) => agentOf(tab) === createdWithAgent) : undefined
}
