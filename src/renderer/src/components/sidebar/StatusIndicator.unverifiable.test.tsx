import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import StatusIndicator from './StatusIndicator'

function render(status: Parameters<typeof StatusIndicator>[0]['status']): string {
  return renderToStaticMarkup(<StatusIndicator status={status} />)
}

// Why: the reported bug was purely visual — 'active' and 'done' render the same
// emerald dot, so a worktree Orca had gone blind on looked finished. These pin
// that the new state is actually distinguishable on screen, not just in the type.
describe('StatusIndicator unverifiable', () => {
  it('does not paint the emerald dot that means done/active', () => {
    expect(render('unverifiable')).not.toContain('bg-emerald-500')
  })

  it('does not reuse the grey inactive dot either', () => {
    expect(render('unverifiable')).not.toContain('bg-neutral-500/40')
  })

  it('renders a dashed ring glyph instead of a filled dot', () => {
    const markup = render('unverifiable')

    expect(markup).toContain('lucide-circle-dashed')
    expect(markup).toContain('text-muted-foreground')
  })

  it('explains itself on hover so the state is self-describing', () => {
    expect(render('unverifiable')).toContain(
      'title="Status unavailable — agent hooks are missing or unreadable"'
    )
  })

  it('stays visually distinct from every other status', () => {
    const markups = (
      [
        'active',
        'done',
        'working',
        'monitoring',
        'interrupted',
        'permission',
        'inactive',
        'unverifiable'
      ] as const
    ).map(render)

    expect(new Set(markups).size).toBe(markups.length)
  })

  it('keeps done and active on the emerald dot — this change is additive', () => {
    expect(render('done')).toContain('bg-emerald-500')
    expect(render('active')).toContain('bg-emerald-500')
  })
})
