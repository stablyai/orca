// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CloudAsleepTerminalNotice } from './CloudAsleepTerminalNotice'
import { CloudWokeProcessesNotice } from './CloudWokeProcessesNotice'

vi.mock('../cloud-workspace-actions', () => ({ wakeCloudWorkspace: vi.fn() }))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_slot: string, name: string) =>
      String(params?.[name] ?? '')
    )
}))
afterEach(() => cleanup())

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
    expect(onRerun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Rerun pnpm dev/ }))
    expect(onRerun).toHaveBeenCalledTimes(1)
  })
})
