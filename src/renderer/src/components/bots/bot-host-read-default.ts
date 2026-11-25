// A bot host read's default load: one RPC fenced to the host incarnation it was sent to.
import type { BotRef } from '@/lib/bot-hosts'
import { reuseEqualJson } from '../../../../shared/reuse-equal-json'
import { callBotRpcWithAuthority, type BotReadAuthority } from './bot-read-authority'

/** What one read sees before it is sent; what it returns finishes the value that read lands. */
export type BotHostReadCapture<T> = (bot: BotRef) => (value: T) => T

export async function readBotHostDefault<T>(
  bot: BotRef,
  method: string,
  previous: T | null,
  live: () => boolean,
  pick: (result: never, authority: BotReadAuthority) => T,
  capture?: BotHostReadCapture<T>
): Promise<T | null> {
  const commit = capture?.(bot)
  const { result, authority } = await callBotRpcWithAuthority<never>(bot, method, { botId: bot.id })
  // A reply no one shows any more is not compared.
  if (!live()) {
    return previous
  }
  const value = pick(result, authority)
  return reuseEqualJson(previous, commit ? commit(value) : value)
}
