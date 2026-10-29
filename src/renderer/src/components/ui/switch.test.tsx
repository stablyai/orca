import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SwitchIndicator } from './switch'

describe('Switch', () => {
  it('renders a visual-only indicator without switch semantics', () => {
    const html = renderToStaticMarkup(<SwitchIndicator checked={false} />)

    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-state="unchecked"')
    expect(html).not.toContain('role="switch"')
  })
})
