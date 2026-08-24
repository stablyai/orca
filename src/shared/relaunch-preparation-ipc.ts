// Why: app.exit(0) skips before-quit/unload, so main must explicitly ask the
// windows that did not invoke the relaunch to run their restart preparation
// (editor hot-exit backup + shutdown checkpoint) before the process dies.
export const APP_RELAUNCH_PREPARE_CHANNEL = 'app:relaunch-prepare'
export const APP_RELAUNCH_PREPARE_REPLY_CHANNEL = 'app:relaunch-prepare-reply'
export const APP_RELAUNCH_PREPARE_ABORT_CHANNEL = 'app:relaunch-prepare-abort'

export type AppRelaunchPrepareRequest = { requestId: number }
export type AppRelaunchPrepareReply = { requestId: number; ok: boolean }
