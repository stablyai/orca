import {
  botToolNameFrom,
  BotToolServerSchema,
  botToolInputError,
  type BotToolServer
} from './bot-tools'
import { extractLeadingEnvAssignments } from './shell/launch/command-environment'
import { tokenizeCustomCommandTemplate } from './source-control/ai/generation/commit-message-prompt'
import { englishTranslate, type CopyTranslate } from './i18n/english-translate'

/** Throws in the reader's words (English for main and the CLI) when the paste is no server. */
export function parseBotToolPaste(
  source: string,
  platform: NodeJS.Platform,
  t: CopyTranslate = englishTranslate
): BotToolServer {
  const text = source.trim()
  const name = botToolNameFrom(text)
  if (/^[{[]/.test(text)) {
    throw new Error(
      t(
        'bots.tools.paste.notConfig',
        'Paste a server URL or start command, or enter the configuration in Edit details.'
      )
    )
  }
  if (/^https?:|^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const result = BotToolServerSchema.safeParse({ name, url: text })
    if (!result.success) {
      throw new Error(
        t('bots.tools.paste.badUrl', 'Use an HTTP or HTTPS URL without embedded credentials.')
      )
    }
    return result.data
  }
  const parsed = tokenizeCustomCommandTemplate(text, platform === 'win32' ? 'literal' : 'escape')
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell) || /[\r\n]/.test(text)) {
    throw new Error(
      t(
        'bots.tools.paste.badCommand',
        'Use a single start command with balanced quotes, or enter the details manually. Shell expressions are not supported.'
      )
    )
  }
  const {
    env,
    rest: [command, ...args]
  } = extractLeadingEnvAssignments(parsed.tokens)
  const input = {
    name: botToolNameFrom([command, ...args].join(' ')),
    command: command ?? '',
    args,
    env: Object.entries(env ?? {}).map(([key, value]) => ({ key, value }))
  }
  const error = botToolInputError(input, platform, t)
  if (error) {
    throw new Error(error)
  }
  return { name: input.name, command: input.command, args, ...(env ? { env } : {}) }
}
