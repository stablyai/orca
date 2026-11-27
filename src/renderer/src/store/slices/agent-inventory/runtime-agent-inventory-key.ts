const WORKSPACE_SEPARATOR = '\u0000'

/** A host-scoped list's runtime: the configured Windows Agent runtime instead of the native host. */
export type RuntimeAgentHostScope = 'configured-windows-runtime'

/** One Windows host can have native and WSL workspaces with different agents; absent workspace uses host defaults. */
export function getRuntimeAgentInventoryKey(
  environmentId: string,
  worktreeId?: string | null,
  hostScope?: RuntimeAgentHostScope
): string {
  if (worktreeId) {
    return `${environmentId}${WORKSPACE_SEPARATOR}${worktreeId}`
  }
  // A leading separator after the id keeps it apart from every workspace id.
  return hostScope
    ? `${environmentId}${WORKSPACE_SEPARATOR}${WORKSPACE_SEPARATOR}${hostScope}`
    : environmentId
}

export function getRuntimeAgentInventoryEnvironmentId(inventoryKey: string): string {
  const separatorIndex = inventoryKey.indexOf(WORKSPACE_SEPARATOR)
  return separatorIndex === -1 ? inventoryKey : inventoryKey.slice(0, separatorIndex)
}
