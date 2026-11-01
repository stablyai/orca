/**
 * WSL hosts Stage 1: the setting governs new projects only. A project the user already has in a
 * distro moves only by their own act (accepting the offer for it, or a move they start); nothing
 * moves it automatically. Stage 2 flips this to let the orchestrator move bridge projects itself.
 */
export const WSL_MOVE_AUTO_MOVES_BRIDGE_PROJECTS = false

export function wslMoveAutoMovesBridgeProjects(): boolean {
  return WSL_MOVE_AUTO_MOVES_BRIDGE_PROJECTS
}
