import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePromptCacheCountdownStartedAt } from './CacheTimer'

const scanMocks = vi.hoisted(() => ({
  getMostUrgentPromptCacheStartedAt: vi.fn(() => 1_000)
}))

type MockState = {
  cacheTimerByKey: Record<string, number | null>
  settings?: {
    promptCacheTimerEnabled?: boolean
    promptCacheTtlMs?: number
  }
  tabsByWorktree: Record<string, { id: string }[]>
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))

vi.mock('./prompt-cache-timer-selection', () => ({
  getMostUrgentPromptCacheStartedAt: scanMocks.getMostUrgentPromptCacheStartedAt,
  getPromptCacheCountdownForPane: vi.fn(() => null)
}))

function AggregateTimerProbe({ active = true }: { active?: boolean }): React.JSX.Element {
  const startedAt = usePromptCacheCountdownStartedAt('wt-1', active)
  return <span>{startedAt ?? 'none'}</span>
}

describe('usePromptCacheCountdownStartedAt', () => {
  beforeEach(() => {
    scanMocks.getMostUrgentPromptCacheStartedAt.mockClear()
    mockState = {
      cacheTimerByKey: { 'tab-1:11111111-1111-4111-8111-111111111111': 1_000 },
      settings: {
        promptCacheTimerEnabled: true,
        promptCacheTtlMs: 60_000
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1' }]
      }
    }
  })

  it('does not scan aggregate cache timers while inactive', () => {
    const markup = renderToStaticMarkup(<AggregateTimerProbe active={false} />)

    expect(markup).toContain('none')
    expect(scanMocks.getMostUrgentPromptCacheStartedAt).not.toHaveBeenCalled()
  })

  it('does not scan aggregate cache timers while disabled', () => {
    mockState.settings = {
      promptCacheTimerEnabled: false,
      promptCacheTtlMs: 60_000
    }

    const markup = renderToStaticMarkup(<AggregateTimerProbe />)

    expect(markup).toContain('none')
    expect(scanMocks.getMostUrgentPromptCacheStartedAt).not.toHaveBeenCalled()
  })

  it('does not scan aggregate cache timers when ttl is zero', () => {
    mockState.settings = {
      promptCacheTimerEnabled: true,
      promptCacheTtlMs: 0
    }

    const markup = renderToStaticMarkup(<AggregateTimerProbe />)

    expect(markup).toContain('none')
    expect(scanMocks.getMostUrgentPromptCacheStartedAt).not.toHaveBeenCalled()
  })

  it('scans aggregate cache timers only when the timer can render', () => {
    const markup = renderToStaticMarkup(<AggregateTimerProbe />)

    expect(markup).toContain('1000')
    expect(scanMocks.getMostUrgentPromptCacheStartedAt).toHaveBeenCalledTimes(1)
    expect(scanMocks.getMostUrgentPromptCacheStartedAt).toHaveBeenCalledWith(
      mockState.tabsByWorktree['wt-1'],
      mockState.cacheTimerByKey
    )
  })
})
