const WORKSPACE_SEPARATOR = '\u0000'

/** One Windows host can have native and WSL workspaces with different agents; absent workspace uses host defaults. */
export function getRuntimeAgentInventoryKey(
  environmentId: string,
  worktreeId?: string | null
): string {
  return worktreeId ? `${environmentId}${WORKSPACE_SEPARATOR}${worktreeId}` : environmentId
}

export function getRuntimeAgentInventoryEnvironmentId(inventoryKey: string): string {
  const separatorIndex = inventoryKey.indexOf(WORKSPACE_SEPARATOR)
  return separatorIndex === -1 ? inventoryKey : inventoryKey.slice(0, separatorIndex)
}
