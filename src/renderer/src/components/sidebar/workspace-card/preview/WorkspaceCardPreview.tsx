import React from 'react'
import { getIntlLocale } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { withCardEvaluationBudget } from '../../../../../../shared/workspace-cards/card-expression'
import {
  PLUGIN_CARD_TEMPLATE_LIMITS,
  type CardTemplate
} from '../../../../../../shared/workspace-cards/card-template-schema'
import type { WorkspaceCardFacts } from '../../../../../../shared/workspace-cards/workspace-card-facts'
import { compileCardTemplate, type CompiledCardTemplate } from '../card-template-compiler'
import { CARD_PREVIEW_ELEMENTS } from './card-preview-elements'
import type { CardPreviewScenario } from './card-preview-scenario'

type CompiledPreview = CompiledCardTemplate<CardPreviewScenario> | null
// By template, then language: `t()` strings are resolved when a template compiles.
const compiled = new WeakMap<CardTemplate, Map<string, CompiledPreview>>()

function compiledPreview(template: CardTemplate): CompiledPreview {
  const locale = getIntlLocale()
  let byLocale = compiled.get(template)
  if (!byLocale) {
    byLocale = new Map()
    compiled.set(template, byLocale)
  }
  if (!byLocale.has(locale)) {
    try {
      byLocale.set(
        locale,
        compileCardTemplate(template, CARD_PREVIEW_ELEMENTS, {
          caps: PLUGIN_CARD_TEMPLATE_LIMITS,
          locale
        })
      )
    } catch {
      byLocale.set(locale, null)
    }
  }
  return byLocale.get(locale) ?? null
}

/** One card drawn from a scenario, inside a copy of the card frame. It reads nothing from the app
 *  store and runs no plugin code, so any template, installed or not, previews safely. */
export function WorkspaceCardPreview({
  template,
  scenario,
  options,
  cardOptions
}: {
  template: CardTemplate
  scenario: CardPreviewScenario
  /** The person's card settings; a scenario may pin its own style (the compact story). */
  options: WorkspaceCardFacts['options']
  cardOptions: WorkspaceCardFacts['cardOptions']
}): React.JSX.Element | null {
  const preview = compiledPreview(template)
  if (!preview) {
    return null
  }
  const pinnedStyle =
    scenario.facts.options.style !== 'classic' ? scenario.facts.options.style : null
  const facts: WorkspaceCardFacts = {
    ...scenario.facts,
    options: pinnedStyle ? { ...options, style: pinnedStyle } : options,
    cardOptions
  }
  let drawn: ReturnType<typeof preview.render>
  try {
    // Previews draw cards that may not be installed: same caps and step budget as the sidebar.
    drawn = withCardEvaluationBudget(PLUGIN_CARD_TEMPLATE_LIMITS.maxEvaluationSteps, () =>
      preview.render(facts, { ...scenario, facts })
    )
  } catch {
    return null
  }
  const { content, frame } = drawn
  return (
    <div
      className={cn(
        'relative ml-1 flex flex-col overflow-hidden rounded-lg border border-transparent pr-1.5',
        frame.singleLine ? 'py-2' : 'pt-1.25 pb-1.5'
      )}
    >
      {content}
    </div>
  )
}
