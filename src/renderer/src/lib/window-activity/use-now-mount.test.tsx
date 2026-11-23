import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNowFromMount } from './use-now'

function Probe({ enabled }: { enabled: boolean }): React.JSX.Element {
  return <span>{useNowFromMount(1_000, enabled)}</span>
}

describe('useNowFromMount on an idle shared clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not hand a disabled caller a snapshot from before it mounted', () => {
    vi.setSystemTime(1_000)
    renderToString(<Probe enabled={false} />)
    vi.setSystemTime(90_000)
    expect(renderToString(<Probe enabled={false} />)).toContain('90000')
  })
})
