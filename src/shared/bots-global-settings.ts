/** Settings › Bots. */
export type BotsGlobalSettings = {
  /** Bots (Settings › Bots), on unless turned off. Off hides every bot surface and skips bot runs; bot folders stay on disk. */
  botsEnabled?: boolean
  /** New Home Chat starts without asking, once the owner ticked Don't ask again. */
  skipNewHomeChatConfirm?: boolean
}
