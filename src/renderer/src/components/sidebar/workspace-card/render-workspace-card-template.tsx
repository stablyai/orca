import type React from 'react'
import type { PluginSidebarCardRegistration } from '../../../../../shared/plugins/artifacts/plugin-sidebar-card-artifact'
import { withCardEvaluationBudget } from '../../../../../shared/workspace-cards/card-expression'
import {
  PLUGIN_CARD_TEMPLATE_LIMITS,
  type CardTemplate
} from '../../../../../shared/workspace-cards/card-template-schema'
import type { WorkspaceCardFacts } from '../../../../../shared/workspace-cards/workspace-card-facts'
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
export type DrawnWorkspaceCard = { content: React.ReactNode; frame: CardFrame }
export type CardRootAttrs = (frame: CardFrame) => Readonly<Record<string, unknown>> | undefined

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
  rootAttrs?: CardRootAttrs,
  cardOptions?: WorkspaceCardFacts['cardOptions']
): DrawnWorkspaceCard {
  return getCompiledWorkspaceCard(template).render(
    buildWorkspaceCardFacts(card, cardOptions),
    card,
    rootAttrs
  )
}

/** Identifies one plugin card file; recompiling only happens when this changes. */
export function pluginCardRevisionKey(entry: PluginSidebarCardRegistration): string {
  return `${entry.id}@${entry.revision}`
}

// Why keyed by revision, failures included: every card shares one compile per file, and a
// broken file is reported once instead of recompiled on each card's render.
const compiledPluginCards = new Map<string, CompiledWorkspaceCard | null>()
const reportedFailures = new Set<string>()

function reportOnce(key: string, reason: unknown): void {
  if (!reportedFailures.has(key)) {
    reportedFailures.add(key)
    console.warn(`[workspace-card] ${key} draws Orca's card instead:`, reason)
  }
}

function compiledPluginCard(entry: PluginSidebarCardRegistration): CompiledWorkspaceCard | null {
  const key = pluginCardRevisionKey(entry)
  if (!compiledPluginCards.has(key)) {
    try {
      compiledPluginCards.set(
        key,
        compileCardTemplate(entry.template, WORKSPACE_CARD_ELEMENTS, PLUGIN_CARD_TEMPLATE_LIMITS)
      )
    } catch (error) {
      reportOnce(key, error)
      compiledPluginCards.set(key, null)
    }
  }
  return compiledPluginCards.get(key) ?? null
}

/** Draws a plugin card within its step budget, or null when it cannot; the caller then draws
 *  Orca's card in Orca's own frame. */
export function renderPluginWorkspaceCard(
  card: WorktreeCardController,
  entry: PluginSidebarCardRegistration,
  rootAttrs?: CardRootAttrs,
  cardOptions?: WorkspaceCardFacts['cardOptions']
): DrawnWorkspaceCard | null {
  const compiled = compiledPluginCard(entry)
  if (!compiled) {
    return null
  }
  try {
    return withCardEvaluationBudget(PLUGIN_CARD_TEMPLATE_LIMITS.maxEvaluationSteps, () =>
      compiled.render(buildWorkspaceCardFacts(card, cardOptions), card, rootAttrs)
    )
  } catch (error) {
    reportOnce(pluginCardRevisionKey(entry), error)
    return null
  }
}

export function renderDefaultWorkspaceCard(
  card: WorktreeCardController,
  rootAttrs?: CardRootAttrs
): DrawnWorkspaceCard {
  return renderWorkspaceCardTemplate(card, DEFAULT_WORKSPACE_CARD_TEMPLATE, rootAttrs)
}
