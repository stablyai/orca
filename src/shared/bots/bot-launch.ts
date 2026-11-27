import * as z from 'zod'
import { readAgentSessionExecutionOptions } from '../agent-session/options/protocol/agent-session-execution-options'
import { OptionKey } from '../rpc-contract/agent-launch/agent-launch-settings-params'
import { parseStructuredLaunchSeedOptions } from '../native-chat/input/session-options/native-chat-session-option-defaults'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../agent-launch/permissions/agent-chat-permission-mode'
import { encodeStructuredAgentSessionOptionValue } from '../agent-session/options/selection/structured-agent-session-option-codec'

const ChoiceValue = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'))

/** The model and session options (effort, fast mode…) the owner picked for the bot's agent; each of its
 *  new chats starts on them. Absent, its chats start on the native chat defaults. Belongs to `agent`:
 *  changing the agent drops it. Permission stays in the bot's own `permissionMode`. */
export const BotLaunchSchema = z
  .object({
    model: ChoiceValue.optional(),
    options: z
      .record(OptionKey, ChoiceValue)
      .refine((value) => Object.keys(value).length <= 32)
      .optional()
  })
  .strict()
  // Values a chat's send would refuse never save, so a saved launch cannot refuse every chat it starts.
  .refine(
    (launch) =>
      readAgentSessionExecutionOptions({
        ...launch.options,
        ...(launch.model ? { model: launch.model } : {})
      }) !== null,
    'Invalid launch choice'
  )

export type BotLaunch = z.infer<typeof BotLaunchSchema>

/** The bot's launch as a new chat's seed options, or undefined when nothing seedable is picked.
 *  Values are the picker's encoded strings (fast mode is "true"), as a saved seed's are. */
export function botLaunchSeedOptions(
  launch: (Pick<BotLaunch, 'model'> & { options?: Readonly<Record<string, string>> }) | undefined
): Record<string, string> | undefined {
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: _permission, ...seed } =
    parseStructuredLaunchSeedOptions({
      ...launch?.options,
      ...(launch?.model ? { model: launch.model } : {})
    }) ?? {}
  return Object.keys(seed).length ? seed : undefined
}

/** What a bot keeps from the agent picker: only the seedable choices made, so everything else
 *  follows the native chat defaults. */
export function botLaunchFromChoices(choices: {
  model?: string
  options?: Readonly<Record<string, string>>
}): BotLaunch | undefined {
  const { model, ...options } = botLaunchSeedOptions(choices) ?? {}
  if (!model && !Object.keys(options).length) {
    return undefined
  }
  return { ...(model ? { model } : {}), ...(Object.keys(options).length ? { options } : {}) }
}

type BotLaunchPick = {
  modelId: string
  optionId: string
  value: string | boolean
  adoptModelAsLaunchDefault?: boolean
}

/** A model or option picked in one of the bot's own conversations, kept on the bot as the owner's
 *  chat picks are kept for chats: a pick for another model starts that model's options afresh, and
 *  a guessed CLI default (`adoptModelAsLaunchDefault: false`) never becomes the bot's model. */
export function botLaunchWithPicks(
  launch: BotLaunch | undefined,
  picks: readonly BotLaunchPick[]
): BotLaunch | undefined {
  let model = launch?.model
  let options: Record<string, string> = { ...launch?.options }
  const adopt = (modelId: string): void => {
    if (model !== undefined && model !== modelId) {
      options = {}
    }
    model = modelId
  }
  for (const pick of picks) {
    if (pick.optionId === 'model') {
      if (pick.adoptModelAsLaunchDefault !== false && typeof pick.value === 'string') {
        adopt(pick.value)
      }
      continue
    }
    if (pick.adoptModelAsLaunchDefault !== false) {
      adopt(pick.modelId)
    } else if (model !== pick.modelId) {
      // An option for a model the bot does not run is not the bot's to keep.
      continue
    }
    const encoded = encodeStructuredAgentSessionOptionValue(pick.optionId, pick.value)
    if (encoded !== null) {
      options[pick.optionId] = encoded
    }
  }
  const next = botLaunchFromChoices({ ...(model ? { model } : {}), options })
  return next && BotLaunchSchema.safeParse(next).success ? next : launch
}
