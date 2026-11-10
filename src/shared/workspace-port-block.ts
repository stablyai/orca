/**
 * Every workspace owns a stable block of ports, so several checkouts of one project can run the
 * same dev server side by side. Scripts read the first port from ORCA_PORT and may use
 * ORCA_PORT..ORCA_PORT+ORCA_PORT_COUNT-1. CONDUCTOR_PORT is the same value for imported scripts.
 */
export const WORKSPACE_PORT_BLOCK_SIZE = 10

/**
 * Below Linux's default ephemeral range (32768+) and macOS's (49152+), so outbound connections
 * never take a block's ports, and above common fixed dev ports (3000, 5173, 8080).
 */
export const WORKSPACE_PORT_RANGE_START = 20000
export const WORKSPACE_PORT_RANGE_END = 32000

export const WORKSPACE_PORT_ENV_KEYS = ['ORCA_PORT', 'ORCA_PORT_COUNT', 'CONDUCTOR_PORT'] as const

export type WorkspacePortBlock = { base: number; count: number }

export function buildWorkspacePortEnv(block: WorkspacePortBlock): Record<string, string> {
  const base = String(block.base)
  return { ORCA_PORT: base, ORCA_PORT_COUNT: String(block.count), CONDUCTOR_PORT: base }
}

export function isPortInWorkspaceBlock(port: number, block: WorkspacePortBlock): boolean {
  return port >= block.base && port < block.base + block.count
}

/**
 * The block a host launcher set for everything it starts (ORCA_PORT in the host process env), or
 * null. A copy inherited from a parent Orca pane carries pane identity and names that pane's
 * workspace instead, so it doesn't count.
 */
export function hostLauncherPortBase(env: NodeJS.ProcessEnv): number | null {
  if (env.ORCA_PANE_KEY || env.ORCA_WORKTREE_ID) {
    return null
  }
  const base = Number(env.ORCA_PORT)
  return Number.isInteger(base) && base >= 1024 && base <= 65535 - WORKSPACE_PORT_BLOCK_SIZE
    ? base
    : null
}
