import type { AvatarImageAgent } from './avatar-generation-contract'

/** Rounded-up median seconds for one avatar run per agent, timed with the app's exact arguments. */
export const AVATAR_TYPICAL_SECONDS: Record<AvatarImageAgent, number> = {
  codex: 40,
  grok: 25,
  antigravity: 60
}

/** Past this share of the typical time, the run is called slower than usual. */
export const AVATAR_SLOW_FACTOR = 1.5
