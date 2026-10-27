import type { NativeChatBlock } from './native-chat-types'

const BASH_INPUT = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/

/** Claude strips ! inside <bash-input>; restore the typed command, returning null for other text. */
export function claudeBashInputAsTypedCommand(text: string): string | null {
  const command = BASH_INPUT.exec(text)?.[1]
  return command === undefined || command.includes('<bash-input>') ? null : `!${command}`
}

export function unwrapClaudeBashInputBlock(block: NativeChatBlock): NativeChatBlock {
  if (block.type !== 'text') {
    return block
  }
  const typed = claudeBashInputAsTypedCommand(block.text)
  return typed === null ? block : { ...block, text: typed }
}
