const WORKSPACE_SEPARATOR = '\u0000'

/** A paired host's agent list is per workspace: two projects on one Windows host can run in
 *  different runtimes (native vs a WSL distro). No workspace means the host-default list. */
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
