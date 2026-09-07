import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Switch, SwitchIndicator } from './switch'

describe('Switch', () => {
  it('renders the checked state with symmetric track geometry', () => {
    const html = renderToStaticMarkup(<Switch checked aria-label="Example setting" />)

    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('p-0.5')
    expect(html).toContain('data-[state=checked]:translate-x-4')
  })

  it('renders a visual-only indicator without switch semantics', () => {
    const html = renderToStaticMarkup(<SwitchIndicator checked={false} />)

    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-state="unchecked"')
    expect(html).not.toContain('role="switch"')
  })

  it('renders compact indicator geometry', () => {
    const html = renderToStaticMarkup(<SwitchIndicator checked size="compact" />)

    expect(html).toContain('h-3.5 w-6')
    expect(html).toContain('size-2.5')
    expect(html).toContain('data-[state=checked]:translate-x-2.5')
  })
})
