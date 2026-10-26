import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeEdgeAuthFields } from './runtime-edge-auth-fields'
describe('desktop edge credential fields', () => {
  it('masks values, labels both fields and bounds additions', () => {
    const markup = renderToStaticMarkup(
      <RuntimeEdgeAuthFields
        rows={[{ id: 'row', name: 'X-Token', value: 'synthetic-secret' }]}
        onChange={vi.fn()}
      />
    )
    expect(markup).toContain('type="password"')
    expect(markup).toContain('Header 1 value')
    expect(markup).toContain('autoComplete="off"')
    expect(markup).toContain('Add header')
  })
})
