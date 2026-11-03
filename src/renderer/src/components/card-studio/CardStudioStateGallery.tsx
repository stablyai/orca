import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useSelectedPluginCard } from '@/store/plugin-sidebar-cards'
import type { CardTemplate } from '../../../../shared/workspace-cards/card-template-schema'
import type { WorkspaceCardFacts } from '../../../../shared/workspace-cards/workspace-card-facts'
import { workspaceCardOptionFacts } from '../sidebar/workspace-card/build-workspace-card-facts'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from '../sidebar/workspace-card/default-workspace-card'
import { cardPreviewScenarios } from '../sidebar/workspace-card/preview/card-preview-scenarios'
import { WorkspaceCardPreview } from '../sidebar/workspace-card/preview/WorkspaceCardPreview'

const NO_OPTIONS: WorkspaceCardFacts['cardOptions'] = {}

function useCardOptionFacts(): WorkspaceCardFacts['options'] {
  const newCardStyle = useAppStore((s) => s.settings?.experimentalNewWorktreeCardStyle === true)
  const compact = useAppStore((s) => s.settings?.compactWorktreeCards === true)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const agentRows = useAppStore((s) => s.agentActivityDisplayMode)
  return useMemo(
    () =>
      workspaceCardOptionFacts({
        newCardStyle,
        compactCards: !newCardStyle && compact,
        cardProps,
        agentActivityDisplayMode: agentRows
      }),
    [newCardStyle, compact, cardProps, agentRows]
  )
}

/** Every important state, drawn from made-up workspaces like a component library's stories.
 *  `template` previews a card that is not in use (or not installed); otherwise the card in use. */
export function CardStudioStateGallery({
  template
}: {
  template?: { template: CardTemplate; options?: WorkspaceCardFacts['cardOptions'] }
}): React.JSX.Element {
  const selected = useSelectedPluginCard()
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const options = useCardOptionFacts()
  const scenarios = useMemo(() => cardPreviewScenarios(), [])
  const shown = template ?? selected ?? { template: DEFAULT_WORKSPACE_CARD_TEMPLATE }
  return (
    <div className="flex flex-wrap gap-4" inert>
      {scenarios.map((scenario) => (
        <figure
          key={scenario.id}
          className="flex flex-col gap-1.5"
          style={{ width: sidebarWidth }}
          data-card-studio-scenario={scenario.id}
        >
          <figcaption className="text-2xs font-medium text-muted-foreground">
            {scenario.title}
          </figcaption>
          <div className="rounded-lg border border-border bg-sidebar py-1 text-sidebar-foreground">
            <WorkspaceCardPreview
              template={shown.template}
              scenario={scenario}
              options={options}
              cardOptions={shown.options ?? NO_OPTIONS}
            />
          </div>
        </figure>
      ))}
    </div>
  )
}
