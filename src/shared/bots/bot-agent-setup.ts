// The agent and launch a bot automation's new conversations start on, and how a save compares them.
import * as z from 'zod'
import type { AutomationBotTarget } from '../automation-bot-target'
import { BOT_AGENTS, type Bot } from '../bot-types'
import { BotLaunchSchema } from './bot-launch'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/** An agent with the launch that belongs to it; a launch never rides into another agent. */
export const BotAgentSetupSchema = lazyZodSchema(() =>
  z.object({ agent: z.enum(BOT_AGENTS), launch: BotLaunchSchema.optional() }).strict()
)

export type BotAgentSetup = z.infer<typeof BotAgentSetupSchema>

function launchKey(setup: BotAgentSetup | undefined): string {
  const options = Object.entries(setup?.launch?.options ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  return JSON.stringify([setup?.agent ?? null, setup?.launch?.model ?? null, options])
}

export function sameBotAgentSetup(
  left: BotAgentSetup | undefined,
  right: BotAgentSetup | undefined
): boolean {
  return launchKey(left) === launchKey(right)
}

/**
 * What a bot automation's runs start on: its own setup for runs in a new conversation, else the
 * bot's. A stored setup this build can't read (an agent since held back) falls back to the bot's.
 */
export function botAutomationSetup(
  target: Pick<AutomationBotTarget, 'runsIn' | 'agentSetup'>,
  bot: Pick<Bot, 'agent' | 'launch'>
): BotAgentSetup & { own: boolean } {
  const own = target.runsIn === 'new' ? BotAgentSetupSchema.safeParse(target.agentSetup) : null
  if (own?.success) {
    return { ...own.data, own: true }
  }
  return { agent: bot.agent, ...(bot.launch ? { launch: bot.launch } : {}), own: false }
}

/** The bot as a conversation on `setup` runs it: same folder, identity, memory and connectors. An
 *  explicit setup replaces the launch, on the bot's own agent too. */
export function botOnSetup<B extends Pick<Bot, 'agent' | 'launch'>>(
  bot: B,
  setup: BotAgentSetup
): B {
  return { ...bot, agent: setup.agent, launch: setup.launch }
}

export function chatRunAgentSetupRefusal(): string {
  return "A run in a chat continues on that chat's agent, so --agent, --model and --effort need --runs-in new."
}
