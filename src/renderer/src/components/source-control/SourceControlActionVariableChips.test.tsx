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

  // Why: the description is the only in-product warning that a bare `Fixes #{linkedIssue}`
  // degrades to `Fixes #`, and the only place a GitLab user learns why it is always empty.
  // A workspace preview must add to it, never replace it.
  it.each([
    { label: 'a linked workspace', preview: '4242', expected: '4242' },
    { label: 'an unlinked workspace', preview: '', expected: '(empty)' }
  ])(
    'keeps the linkedIssue description and example alongside $label preview',
    ({ preview, expected }) => {
      const markup = renderToStaticMarkup(
        <SourceControlActionVariableChips
          actionId="commitMessage"
          variablePreviews={{ linkedIssue: preview }}
          onInsert={() => {}}
        />
      )

      expect(markup).toContain('Empty when no GitHub issue is linked')
      expect(markup).toContain('GitLab-linked')
      expect(markup).toContain('Example')
      expect(markup).toContain('This workspace')
      expect(markup).toContain(expected)
    }
  )

  it('shows only the rendered prompt for a basePrompt preview', () => {
    const markup = renderToStaticMarkup(
      <SourceControlActionVariableChips
        actionId="commitMessage"
        variablePreviews={{ basePrompt: 'Generate a commit message.' }}
        onInsert={() => {}}
      />
    )

    expect(markup).not.toContain('built-in prompt for this action')
  })
})
