import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null
}))

const { LinearProjectTableContent } =
  await import('./task-page/linear/projects/linear-project-table-content')

describe('LinearProjectTableContent', () => {
  const projects = [
    {
      id: 'project-1',
      name: 'Stably',
      url: 'https://linear.app/stably/project/stably',
      updatedAt: '2026-08-07T12:00:00.000Z'
    }
  ]

  function renderTable(): string {
    return renderToStaticMarkup(
      <LinearProjectTableContent
        projects={projects}
        loading={false}
        onSelectProject={() => {}}
        onOpenProject={() => {}}
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
