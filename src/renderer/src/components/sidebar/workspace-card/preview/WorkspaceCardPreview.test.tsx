// @vitest-environment happy-dom

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { cardTemplateSchema } from '../../../../../../shared/workspace-cards/card-template-schema'
import { cardTemplateIssues } from '../../../../../../shared/workspace-cards/card-template-validation'

// The SSH control reads one shared action; previews read nothing keyed by a workspace.
vi.mock('@/store', () => {
  const getState = () => ({ setSshConnectionState: () => {} })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState
    })
  }
})
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-tooltip="">{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const { WorkspaceCardPreview } = await import('./WorkspaceCardPreview')
const { cardPreviewScenarios } = await import('./card-preview-scenarios')
const { DEFAULT_WORKSPACE_CARD_TEMPLATE } = await import('../default-workspace-card')

const officialDir = join(
  process.cwd(),
  'resources/plugins/launch/stablyai.orca-workspace-cards/cards'
)
const templates = [
  ['orca', DEFAULT_WORKSPACE_CARD_TEMPLATE] as const,
  ...readdirSync(officialDir).map(
    (file) =>
      [
        file,
        cardTemplateSchema.parse(JSON.parse(readFileSync(join(officialDir, file), 'utf8')))
      ] as const
  )
]

describe('workspace card previews', () => {
  it.each(templates)('%s validates and draws every gallery state', (_name, template) => {
    expect(cardTemplateIssues(template)).toEqual([])
    for (const scenario of cardPreviewScenarios()) {
      const markup = renderToStaticMarkup(
        <WorkspaceCardPreview
          template={template}
          scenario={scenario}
          options={scenario.facts.options}
          cardOptions={{ showBranch: true }}
        />
      )
      expect(markup, scenario.id).toContain(scenario.facts.ws.title.slice(0, 12))
    }
  })

  it('draws the states it is named for', () => {
    const byId = new Map(cardPreviewScenarios().map((scenario) => [scenario.id, scenario]))
    const draw = (id: string) =>
      renderToStaticMarkup(
        <WorkspaceCardPreview
          template={DEFAULT_WORKSPACE_CARD_TEMPLATE}
          scenario={byId.get(id)!}
          options={byId.get(id)!.facts.options}
          cardOptions={{}}
        />
      )
    expect(draw('conflicts')).toContain('already exists')
    expect(draw('conflicts')).toContain('Merging')
    expect(draw('working')).toContain('Rebuilding the card template compiler')
    expect(draw('detached')).toContain('Detached HEAD')
    expect(draw('folder')).toContain('notes')
  })
})
