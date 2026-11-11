// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CloudAsleepTerminalNotice, formatAsleepSince } from './CloudAsleepTerminalNotice'
import { CloudWokeProcessesNotice, truncateMiddle } from './CloudWokeProcessesNotice'
import { noteUserInputForPane } from '@/components/terminal-pane/input/pane-user-input'
import {
  captureWakeProcessHint,
  cursorBelowLastText,
  getWakeProcessHint,
  readTerminalTail,
  resetWakeProcessHintsForTests
} from '@/lib/orca-cloud/cloud-wake-process-hints'
import { cloudWokeActionFor, runCloudWokeAction } from '@/lib/orca-cloud/cloud-wake-hint-action'

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
  // WAKE-RERUN (cut 68321452c97c): a shell pane running `sleep 900` woke with no bar.
  it('a shell pane that was running a silent `sleep 900` wakes to Rerun sleep 900', () => {
    resetWakeProcessHintsForTests()
    const lines = ['ubuntu@ik-wake:~/Hello-World/ik-wake$ sleep 900', '', '']
    const pane = {
      buffer: {
        active: {
          length: lines.length,
          baseY: 0,
          // Enter was pressed: the cursor sits on the row below the command.
          cursorY: 1,
          getLine: (index: number) => ({ translateToString: () => lines[index] ?? '' })
        }
      }
    }
    // Asleep: the pane's pre-sleep screen is captured the way the recovery portal does it.
    captureWakeProcessHint('leaf-shell', readTerminalTail(pane), {
      agentType: null,
      alternateScreen: false,
      cursorBelowText: cursorBelowLastText(pane)
    })
    // Awake: the strip the portal renders for that hint.
    const hint = getWakeProcessHint('leaf-shell')
    expect(hint).toEqual({ command: 'sleep 900' })
    const sendInput = vi.fn()
    render(
      <CloudWokeProcessesNotice
        action={cloudWokeActionFor(hint!)}
        onAction={() =>
          runCloudWokeAction(hint!, {
            tabId: 'tab-1',
            leafId: 'leaf-shell',
            worktreeId: 'wt-1',
            sendInput
          })
        }
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText('Woke up · processes stopped while asleep')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Rerun sleep 900/ }))
    expect(sendInput).toHaveBeenCalledWith('sleep 900\r')
    resetWakeProcessHintsForTests()
  })

  it('never reruns by itself; Rerun sends only when clicked', () => {
    const onRerun = vi.fn()
    render(
      <CloudWokeProcessesNotice
        action={{ kind: 'rerun', command: 'pnpm dev' }}
        onAction={onRerun}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText('Woke up · processes stopped while asleep')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Rerun pnpm dev/ }).getAttribute('title')).toBe(
      'pnpm dev'
    )
    expect(onRerun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Rerun pnpm dev/ }))
    expect(onRerun).toHaveBeenCalledTimes(1)
  })

  // JA-15: an agent pane offers its Restart, never its input box as a command.
  it('offers Restart Claude on an agent pane, with no command shown', () => {
    const onRestart = vi.fn()
    render(
      <CloudWokeProcessesNotice
        action={{ kind: 'restart', agent: 'Claude' }}
        onAction={onRestart}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /Rerun/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restart Claude' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
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
        action={{ kind: 'rerun', command: 'pnpm dev' }}
        paneLeafId="leaf-x"
        onAction={vi.fn()}
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
