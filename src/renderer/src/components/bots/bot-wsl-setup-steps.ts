// The steps New bot shows while it sets a WSL distro up as a host, and which one is under way.
import type { WslHostAddStage } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

/** Main's add stages, then the agent check New bot runs itself once the host exists. */
export type BotWslSetupStage = WslHostAddStage | 'finding-agents'

export const BOT_WSL_SETUP_STEPS: readonly BotWslSetupStage[] = [
  'starting-distro',
  'installing-server',
  'connecting',
  'finding-agents'
]

export type BotWslSetupStepState = 'done' | 'active' | 'pending'

/** Steps before `stage` are done; no stage yet (or an older main that sends none) reads as the first. */
export function botWslSetupStepStates(
  stage: BotWslSetupStage | null
): { step: BotWslSetupStage; state: BotWslSetupStepState }[] {
  const current = Math.max(0, stage ? BOT_WSL_SETUP_STEPS.indexOf(stage) : 0)
  return BOT_WSL_SETUP_STEPS.map((step, index) => ({
    step,
    state: index < current ? 'done' : index === current ? 'active' : 'pending'
  }))
}

/** A stage never moves back: a late lock-wait message keeps the step already reached. */
export function laterBotWslSetupStage(
  previous: BotWslSetupStage | null,
  next: BotWslSetupStage | undefined
): BotWslSetupStage | null {
  if (!next) {
    return previous
  }
  if (!previous) {
    return next
  }
  return BOT_WSL_SETUP_STEPS.indexOf(next) > BOT_WSL_SETUP_STEPS.indexOf(previous) ? next : previous
}
