// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { PaneTopBanner } from '../appearance/pane-top-banner/PaneTopWarningBanner'
import { workerAutoCloseBannerProps } from './worker-auto-close-banner'

const t: Translate = (_key, fallback, options) =>
  fallback.replace('{{countdown}}', String(options?.countdown ?? ''))

const CLOSES_AT = '2026-11-17T12:02:00.000Z'

function bannerAt(nowIso: string): React.JSX.Element {
  const props = workerAutoCloseBannerProps(
    { kept: false, closesAt: CLOSES_AT },
    Date.parse(nowIso),
    () => {},
    t
  )
  if (!props) {
    throw new Error('expected a banner')
  }
  return <PaneTopBanner {...props} />
}

afterEach(cleanup)

describe('worker auto-close banner live region', () => {
  it('keeps the announced text still while the visible countdown ticks', () => {
    const { rerender } = render(bannerAt('2026-11-17T12:00:18.000Z'))
    const announcedBefore = screen.getByRole('status').textContent
    expect(screen.getByText(/1:42/)).toBeTruthy()

    rerender(bannerAt('2026-11-17T12:00:19.000Z'))

    expect(screen.getByText(/1:41/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(announcedBefore)
    expect(announcedBefore).not.toMatch(/1:4\d/)
  })
})
