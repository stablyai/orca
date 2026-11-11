// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CloudAsleepTerminalNotice, formatAsleepSince } from './CloudAsleepTerminalNotice'
import { CloudWokeProcessesNotice, truncateMiddle } from './CloudWokeProcessesNotice'
import { noteUserInputForPane } from '@/components/terminal-pane/input/pane-user-input'

vi.mock('../cloud-workspace-actions', () => ({ wakeCloudWorkspace: vi.fn() }))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_slot: string, name: string) =>
      String(params?.[name] ?? '')
    )
}))
afterEach(() => cleanup())
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
)

describe('CloudAsleepTerminalNotice', () => {
  it('greys the scrollback and shows the "Asleep since" divider', () => {
    const { container } = render(
      <CloudAsleepTerminalNotice workspaceId="ws" asleepSince={Date.UTC(2026, 10, 10, 15, 10)} />
    )
    expect(container.querySelector('[data-cloud-asleep-scrim]')).not.toBeNull()
    expect(container.querySelector('[data-cloud-asleep-divider]')?.textContent).toMatch(
      /^Asleep since /
    )
  })

  it('puts the divider right under the last line of history', () => {
    const { container } = render(
      <CloudAsleepTerminalNotice
        workspaceId="ws"
        asleepSince={Date.UTC(2026, 10, 10, 15, 10)}
        historyEndPx={44}
      />
    )
    const divider = container.querySelector<HTMLElement>('[data-cloud-asleep-divider]')
    expect(divider?.style.top).toBe('44px')
    expect(divider?.className).toContain('absolute')
  })

  it('omits the divider when the sleep time is unknown', () => {
    const { container } = render(<CloudAsleepTerminalNotice workspaceId="ws" asleepSince={null} />)
    expect(container.querySelector('[data-cloud-asleep-divider]')).toBeNull()
  })
})

describe('CloudWokeProcessesNotice', () => {
  it('never reruns by itself; Rerun sends only when clicked', () => {
    const onRerun = vi.fn()
    render(<CloudWokeProcessesNotice command="pnpm dev" onRerun={onRerun} onDismiss={vi.fn()} />)
    expect(screen.getByText('Woke up · processes stopped while asleep')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Rerun pnpm dev/ }).getAttribute('title')).toBe(
      'pnpm dev'
    )
    expect(onRerun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Rerun pnpm dev/ }))
    expect(onRerun).toHaveBeenCalledTimes(1)
  })

  it('truncates a long command in the middle, keeping both ends', () => {
    const long = 'python3 -m http.server --directory /very/long/path/to/site 8000'
    const short = truncateMiddle(long, 24)
    expect(short.length).toBe(24)
    expect(short.startsWith('python3')).toBe(true)
    expect(short.endsWith('8000')).toBe(true)
  })

  it('goes away once the person types in the pane', () => {
    const onDismiss = vi.fn()
    render(
      <CloudWokeProcessesNotice
        command="pnpm dev"
        paneLeafId="leaf-x"
        onRerun={vi.fn()}
        onDismiss={onDismiss}
      />
    )
    noteUserInputForPane('leaf-other')
    expect(onDismiss).not.toHaveBeenCalled()
    noteUserInputForPane('leaf-x')
    expect(onDismiss).toHaveBeenCalled()
  })
})

describe('formatAsleepSince', () => {
  it('adds the date once it has been asleep across a day boundary', () => {
    const at = new Date(2026, 10, 10, 15, 10).getTime()
    expect(formatAsleepSince(at, new Date(2026, 10, 10, 18, 0).getTime())).not.toMatch(/Nov/)
    expect(formatAsleepSince(at, new Date(2026, 10, 11, 9, 0).getTime())).toMatch(/Nov/)
  })
})
