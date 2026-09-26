import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Badge } from './badge'

function classTokens(html: string): string[] {
  return /class="([^"]*)"/.exec(html)?.[1].split(' ') ?? []
}

describe('Badge', () => {
  it('keeps the pill geometry by default', () => {
    const classes = classTokens(renderToStaticMarkup(<Badge variant="destructive">Label</Badge>))

    expect(classes).toEqual(expect.arrayContaining(['rounded-full', 'px-2', 'text-xs']))
    expect(classes).not.toContain('h-4')
  })

  it('replaces the pill geometry with the compact square chip', () => {
    const classes = classTokens(
      renderToStaticMarkup(
        <Badge variant="destructive" size="compact">
          Label
        </Badge>
      )
    )

    expect(classes).toEqual(
      expect.arrayContaining(['h-4', 'rounded', 'px-1.5', 'text-[10px]', 'leading-none'])
    )
    expect(classes).not.toContain('rounded-full')
    expect(classes).not.toContain('px-2')
    expect(classes).not.toContain('text-xs')
    expect(classes).toContain('bg-destructive')
  })
})
