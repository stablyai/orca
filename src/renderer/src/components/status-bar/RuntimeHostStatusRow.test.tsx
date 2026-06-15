import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeHostStatusRow } from './RuntimeHostStatusRow'

describe('RuntimeHostStatusRow', () => {
  it('renders reconnecting diagnostics for remote hosts', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostStatusRow label="Dev Box" state="reconnecting" detail="Attempt 3" />
    )

    expect(markup).toContain('Dev Box')
    expect(markup).toContain('Reconnecting')
    expect(markup).toContain('Attempt 3')
  })

  it('renders disconnected hosts with a connect action', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostStatusRow
        label="Dev Box"
        state="disconnected"
        detail="Last closed: 1006"
        onConnect={async () => {}}
      />
    )

    expect(markup).toContain('Dev Box')
    expect(markup).toContain('Remote Server')
    expect(markup).toContain('Disconnected')
    expect(markup).toContain('Last closed: 1006')
    expect(markup).toContain('Connect')
  })

  it('renders connected hosts with a disconnect action', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostStatusRow label="Dev Box" state="connected" onDisconnect={async () => {}} />
    )

    expect(markup).toContain('Dev Box')
    expect(markup).toContain('Connected')
    expect(markup).toContain('Disconnect')
  })
})
