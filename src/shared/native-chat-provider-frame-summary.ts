import type { NativeChatBlock } from './native-chat-types'

type ProviderFrameTextBlock = Extract<NativeChatBlock, { type: 'text' }>

export function nativeChatProviderFrameSummary(block: ProviderFrameTextBlock): string {
  const frame = block.providerFrame
  if (!frame) {
    return block.text
  }
  return block.text === `${frame.provider} · ${frame.kind}` ? frame.kind : block.text
}
