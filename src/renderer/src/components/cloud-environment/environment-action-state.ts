/** In-flight and last-result state of the panel's mutations. */
export type ActionState = {
  saving: boolean
  starting: boolean
  busyBuildId: string | null
  saveError: string | null
  conflict: boolean
  actionError: string | null
}

export const idleActions: ActionState = {
  saving: false,
  starting: false,
  busyBuildId: null,
  saveError: null,
  conflict: false,
  actionError: null
}
