// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import type { WorkerAutoCloseState } from '../../../../../shared/orchestration/workers/worker-auto-close'
import { PaneTopBanner } from '../appearance/pane-top-banner/PaneTopWarningBanner'
import { workerAutoCloseBannerProps } from './worker-auto-close-banner'

const t: Translate = (_key, fallback, options) =>
  fallback.replace('{{countdown}}', String(options?.countdown ?? ''))

const RUNNING: WorkerAutoCloseState = { kept: false, closesAt: null }
const FINISHED: WorkerAutoCloseState = { kept: false, closesAt: '2026-11-17T12:02:00.000Z' }

function bannerAt(state: WorkerAutoCloseState, nowIso: string): React.JSX.Element {
  const props = workerAutoCloseBannerProps(state, Date.parse(nowIso), () => {}, t)
  if (!props) {
    throw new Error('expected a banner')
  }
  return <PaneTopBanner {...props} />
}

afterEach(cleanup)

describe('worker auto-close banner live region', () => {
  it('mounts one empty status node inside a banner that has no role of its own', () => {
    const { container } = render(bannerAt(RUNNING, '2026-11-17T12:00:00.000Z'))

    const [status, ...others] = screen.getAllByRole('status')
    expect(others).toHaveLength(0)
    expect(status.textContent).toBe('')
    expect(status.className).toContain('sr-only')
    expect(container.firstElementChild?.getAttribute('role')).toBeNull()
  })

  it('fills the same node on finish, time-free, and holds it still while the countdown ticks', () => {
    const { rerender } = render(bannerAt(RUNNING, '2026-11-17T12:00:00.000Z'))
    const status = screen.getByRole('status')

    rerender(bannerAt(FINISHED, '2026-11-17T12:00:18.000Z'))
    expect(screen.getByText(/1:42/)).toBeTruthy()
    // A re-mounted, pre-filled region may not be announced; it must be the node that mounted empty.
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('Orchestration worker finished · Closes soon')

    rerender(bannerAt(FINISHED, '2026-11-17T12:00:19.000Z'))
    expect(screen.getByText(/1:41/)).toBeTruthy()
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('Orchestration worker finished · Closes soon')
  })

  it('mounts an empty status node even when the worker has already finished', () => {
    let statusAtMount: HTMLElement | undefined
    let textAtMount: string | null | undefined
    function FinishedBanner() {
      useLayoutEffect(() => {
        statusAtMount = screen.getByRole('status')
        textAtMount = statusAtMount.textContent
      }, [])
      return bannerAt(FINISHED, '2026-11-17T12:01:59.000Z')
    }

    render(<FinishedBanner />)

    expect(textAtMount).toBe('')
    expect(screen.getByRole('status')).toBe(statusAtMount)
    expect(statusAtMount?.textContent).toBe('Orchestration worker finished · Closes soon')
  })
})
