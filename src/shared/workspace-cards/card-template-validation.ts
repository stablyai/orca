import { CARD_ELEMENT_PROPS, isCardElementName } from './card-element-catalog'
import { expandCardTemplate } from './card-template-expansion'
import type { CardTemplate } from './card-template-schema'

/** Why the renderer would refuse this template, as `path: message`; empty when it draws.
 *  Runs the renderer's own expansion, so plugin templates meet exactly the same rules and caps. */
export function cardTemplateIssues(template: CardTemplate): string[] {
  try {
    expandCardTemplate(template, (el) =>
      isCardElementName(el) ? CARD_ELEMENT_PROPS[el] : undefined
    )
    return []
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}
