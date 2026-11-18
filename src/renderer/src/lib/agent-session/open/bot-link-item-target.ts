import { create } from 'zustand'

export type BotLinkItemTarget = { sessionId: string; itemId: string }

/** Scroll once; the selected pending prompt stays selected until it resolves. */
export const useBotLinkItemTarget = create<{
  target: BotLinkItemTarget | null
  prompt: BotLinkItemTarget | null
}>()(() => ({ target: null, prompt: null }))

export function targetBotLinkItem(sessionId: string, itemId?: string): void {
  const target = itemId ? { sessionId, itemId } : null
  useBotLinkItemTarget.setState({ target, prompt: target })
}

export function consumeBotLinkItem(target: BotLinkItemTarget): void {
  if (useBotLinkItemTarget.getState().target === target) {
    useBotLinkItemTarget.setState({ target: null })
  }
}

export function useBotLinkPrompt<T extends { itemId: string }>(
  sessionId: string,
  prompts: readonly T[]
): T | null {
  const target = useBotLinkItemTarget((state) => state.prompt)
  return (
    (target?.sessionId === sessionId
      ? prompts.find((item) => item.itemId === target.itemId)
      : null) ??
    prompts[0] ??
    null
  )
}
