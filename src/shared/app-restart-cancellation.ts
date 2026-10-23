// Why a message and not an error property: rejections cross the preload bridge with only their message.
export const APP_RESTART_CANCELLED_BY_USER_MESSAGE = 'Restart cancelled to keep unsaved changes.'

/** The user chose Cancel in the unsaved-changes dialog; callers reset quietly instead of reporting an error. */
export function isRestartCancelledByUser(error: unknown): boolean {
  return error instanceof Error && error.message === APP_RESTART_CANCELLED_BY_USER_MESSAGE
}
