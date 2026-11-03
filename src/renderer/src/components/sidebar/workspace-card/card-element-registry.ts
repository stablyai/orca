import type { WorktreeCardController } from '../use-worktree-card-controller'
import { CARD_ACTIVITY_PARTS } from './card-activity-parts'
import { CARD_IDENTITY_PARTS } from './card-identity-parts'
import { CARD_PRIMITIVES } from './card-primitives'
import type { CardElementName } from '../../../../../shared/workspace-cards/card-element-catalog'
import type { CardElement } from './card-template-compiler'

/** Every element a card template can name: layout and text primitives plus Orca's own parts. */
export const WORKSPACE_CARD_ELEMENTS: Readonly<
  Record<CardElementName, CardElement<WorktreeCardController>>
> = {
  ...CARD_PRIMITIVES,
  ...CARD_IDENTITY_PARTS,
  ...CARD_ACTIVITY_PARTS
}
