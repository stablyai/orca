/**
 * Formats a recovery action for a missing Computer Use helper.
 */
export function computerUseHelperGuidance(reason: string, isDevelopment: boolean): string {
  const detail = `Computer Use is unavailable because ${reason}.`
  if (isDevelopment) {
    return `${detail} Run pnpm build:computer-macos and restart Orca from this worktree.`
  }
  return `${detail} Update or reinstall Orca to restore the bundled helper.`
}
