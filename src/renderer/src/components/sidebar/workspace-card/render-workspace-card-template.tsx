import type React from 'react'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import type { CardTemplate } from '../../../../../shared/workspace-cards/card-template-schema'
import type { WorktreeCardController } from '../use-worktree-card-controller'
import { buildWorkspaceCardFacts } from './build-workspace-card-facts'
import { WORKSPACE_CARD_ELEMENTS } from './card-element-registry'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from './default-workspace-card'
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

type RootAttrs = (frame: CardFrame) => Readonly<Record<string, unknown>> | undefined

/** Draws a plugin card, or Orca's card when there is none or the plugin card fails. */
export function renderWorkspaceCardWithFallback(
  card: WorktreeCardController,
  pluginTemplate: CardTemplate | null,
  rootAttrs?: RootAttrs
): { content: React.ReactNode; frame: CardFrame } {
  const drawDefault = () =>
    renderWorkspaceCardTemplate(card, DEFAULT_WORKSPACE_CARD_TEMPLATE, rootAttrs)
  if (!pluginTemplate) {
    return drawDefault()
  }
  let drawn: { content: React.ReactNode; frame: CardFrame }
  try {
    drawn = renderWorkspaceCardTemplate(card, pluginTemplate, rootAttrs)
  } catch (error) {
    console.error("[workspace-card] plugin card failed; drawing Orca's card", error)
    return drawDefault()
  }
  return {
    frame: drawn.frame,
    content: (
      <RecoverableRenderErrorBoundary
        boundaryId="workspace-card-plugin"
        surface="sidebar"
        reportAsCrash={false}
        fallback={() => drawDefault().content}
      >
        {drawn.content}
      </RecoverableRenderErrorBoundary>
    )
  }
}
