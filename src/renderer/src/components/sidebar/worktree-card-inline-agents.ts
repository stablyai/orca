import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'

/** Whether a card lists its agent rows: the card property, or forced by the expanded compact project. */
export function shouldShowInlineAgentList(args: {
  forceInlineAgents: boolean
  cardProps: readonly WorktreeCardProperty[]
  newCardStyle: boolean
  compactCards: boolean
}): boolean {
  return (
    args.forceInlineAgents ||
    (args.cardProps.includes('inline-agents') && (args.newCardStyle || !args.compactCards))
  )
}
