// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetRemoteServerNoticeClaimsForTests,
  useRemoteServerNoticeClaim,
  type RemoteServerNoticeClaim
} from './remote-server-notice-claims'

const seen = new Map<string, RemoteServerNoticeClaim>()

function Surface({
  name,
  environmentId,
  visible = true
}: {
  name: string
  environmentId: string | null
  visible?: boolean
}) {
  seen.set(name, useRemoteServerNoticeClaim(environmentId, environmentId !== null, visible))
  return null
}

afterEach(() => {
  cleanup()
  resetRemoteServerNoticeClaimsForTests()
  seen.clear()
  vi.useRealTimers()
})

describe('useRemoteServerNoticeClaim', () => {
  it('lets one visible surface speak for a dropped server while the rest stay quiet', () => {
    render(
      <>
        <Surface name="hidden" environmentId="env-a" visible={false} />
        <Surface name="left" environmentId="env-a" />
        <Surface name="right" environmentId="env-a" />
        <Surface name="local" environmentId={null} />
      </>
    )

    expect(seen.get('hidden')).toMatchObject({ speaks: false, quiet: true })
    expect(seen.get('left')).toMatchObject({ speaks: true, quiet: true })
    expect(seen.get('right')).toMatchObject({ speaks: false, quiet: true })
    expect(seen.get('local')).toMatchObject({ speaks: false, quiet: false })
  })

  it('keeps the outage start from a hidden tab when another tab becomes the speaker', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const view = render(
      <>
        <Surface name="background" environmentId="env-b" visible={false} />
        <Surface name="front" environmentId="env-b" visible={false} />
      </>
    )
    expect(seen.get('front')).toMatchObject({ quiet: false, since: 1_000 })
    vi.setSystemTime(9_000)

    act(() =>
      view.rerender(
        <>
          <Surface name="background" environmentId="env-b" visible={false} />
          <Surface name="front" environmentId="env-b" />
        </>
      )
    )

    expect(seen.get('front')).toMatchObject({ speaks: true, since: 1_000 })
  })
})
