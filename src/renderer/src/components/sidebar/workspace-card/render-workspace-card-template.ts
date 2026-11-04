import type React from 'react'
import type { CardTemplate } from '../../../../../shared/workspace-cards/card-template-schema'
import type { WorktreeCardController } from '../use-worktree-card-controller'
import { buildWorkspaceCardFacts } from './build-workspace-card-facts'
import { WORKSPACE_CARD_ELEMENTS } from './card-element-registry'
import {
  compileCardTemplate,
  type CardFrame,
  type CompiledCardTemplate
} from './card-template-compiler'

type CompiledWorkspaceCard = CompiledCardTemplate<WorktreeCardController>

const compiledTemplates = new WeakMap<CardTemplate, CompiledWorkspaceCard>()

export function getCompiledWorkspaceCard(template: CardTemplate): CompiledWorkspaceCard {
  let compiled = compiledTemplates.get(template)
  if (!compiled) {
    compiled = compileCardTemplate(template, WORKSPACE_CARD_ELEMENTS)
    compiledTemplates.set(template, compiled)
  }
  return compiled
}

/** Draws one card's content from a template; the caller owns the card frame around it. */
export function renderWorkspaceCardTemplate(
  card: WorktreeCardController,
  template: CardTemplate,
  rootAttrs?: (frame: CardFrame) => Readonly<Record<string, unknown>> | undefined
): { content: React.ReactNode; frame: CardFrame } {
  return getCompiledWorkspaceCard(template).render(buildWorkspaceCardFacts(card), card, rootAttrs)
}
