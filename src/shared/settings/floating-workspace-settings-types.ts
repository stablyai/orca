/** Main-owned Floating Workspace rollout state; only the profile loader writes these. */
export type FloatingWorkspaceRolloutSettings = {
  /** One-shot migration flag for the floating-workspace default-on rollout; after migration an explicit off sticks. */
  floatingTerminalDefaultedForAllUsers?: boolean
  /** Frozen at first load: existing profiles keep Floating Workspace in Settings; new ones never see it. */
  floatingWorkspaceInSettings?: boolean
}
