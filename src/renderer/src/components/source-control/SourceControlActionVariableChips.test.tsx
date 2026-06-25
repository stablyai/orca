import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlActionVariableChips } from './SourceControlActionVariableChips'

vi.mock('../ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => (
    <div data-slot="hover-card">{children}</div>
  ),
  HoverCardContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-slot="hover-card-content" className={className}>
      {children}
    </div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => (
    <div data-slot="hover-card-trigger">{children}</div>
  )
}))

describe('SourceControlActionVariableChips', () => {
  it('renders variable details in a scrollable hover card', () => {
    const markup = renderToStaticMarkup(
      <SourceControlActionVariableChips
        actionId="commitMessage"
        variablePreviews={{ basePrompt: 'Generate a commit message.\n\nInclude staged changes.' }}
        onInsert={() => {}}
      />
    )

    expect(markup).toContain('data-slot="hover-card-content"')
    expect(markup).toContain('scrollbar-sleek')
    expect(markup).toContain('overflow-y-auto')
    expect(markup).toContain('Generate a commit message.')
  })
})
