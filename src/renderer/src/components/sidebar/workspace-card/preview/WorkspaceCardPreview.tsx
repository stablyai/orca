import React from 'react'
import { cn } from '@/lib/utils'
import type { CardTemplate } from '../../../../../../shared/workspace-cards/card-template-schema'
import type { WorkspaceCardFacts } from '../../../../../../shared/workspace-cards/workspace-card-facts'
import { compileCardTemplate, type CompiledCardTemplate } from '../card-template-compiler'
import { CARD_PREVIEW_ELEMENTS } from './card-preview-elements'
import type { CardPreviewScenario } from './card-preview-scenario'

const compiled = new WeakMap<CardTemplate, CompiledCardTemplate<CardPreviewScenario> | null>()

function compiledPreview(template: CardTemplate): CompiledCardTemplate<CardPreviewScenario> | null {
  if (!compiled.has(template)) {
    try {
      compiled.set(template, compileCardTemplate(template, CARD_PREVIEW_ELEMENTS))
    } catch {
      compiled.set(template, null)
    }
  }
  return compiled.get(template) ?? null
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
  const { content, frame } = preview.render(facts, { ...scenario, facts })
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
