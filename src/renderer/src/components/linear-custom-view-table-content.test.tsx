import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null
}))

const { LinearCustomViewTableContent } =
  await import('./task-page/linear/views/linear-custom-view-table-content')

describe('LinearCustomViewTableContent', () => {
  const views = [
    {
      id: 'view-1',
      name: 'Triage',
      model: 'issue' as const,
      shared: true,
      updatedAt: '2026-08-07T12:00:00.000Z'
    }
  ]

  function renderTable(): string {
    return renderToStaticMarkup(
      <LinearCustomViewTableContent
        views={views}
        loading={false}
        onSelectView={() => {}}
        onOpenView={() => {}}
      />
    )
  }

  it('reveals row actions on hover-capable pointers only', () => {
    const markup = renderTable()
    expect(markup).toContain('md:can-hover:opacity-0')
    expect(markup).toContain('md:group-hover/row:opacity-100')
    expect(markup).toContain('md:group-focus-within/row:opacity-100')
    expect(markup).not.toContain('md:opacity-0')
  })
})
