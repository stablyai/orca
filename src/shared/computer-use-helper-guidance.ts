/** Recovery action for the native Computer Use helper in a source checkout. */
export const COMPUTER_USE_HELPER_DEVELOPMENT_ACTION =
  'pnpm build:computer-macos and restart Orca from this worktree'

/** Guidance for restoring the native Computer Use helper in an installed app. */
export const COMPUTER_USE_HELPER_PACKAGED_GUIDANCE =
  'Update or reinstall Orca to restore the bundled helper.'

/** Formats environment-specific recovery copy for an unavailable helper. */
export function computerUseHelperGuidance(reason: string, isDevelopment: boolean): string {
  const detail = `Computer Use is unavailable because ${reason}.`
  const recovery = isDevelopment
    ? `Run ${COMPUTER_USE_HELPER_DEVELOPMENT_ACTION}.`
    : COMPUTER_USE_HELPER_PACKAGED_GUIDANCE
  return `${detail} ${recovery}`
}
