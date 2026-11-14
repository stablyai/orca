import {
  cardTemplateSchema,
  type CardTemplate
} from '../../../../../../shared/workspace-cards/card-template-schema'
import defaultCardJson from './default-workspace-card.json'

/** Today's card, as the built-in card template; the parity tests hold it to the original. */
export const DEFAULT_WORKSPACE_CARD_TEMPLATE: CardTemplate =
  cardTemplateSchema.parse(defaultCardJson)
