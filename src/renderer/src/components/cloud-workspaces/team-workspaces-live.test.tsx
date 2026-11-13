// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setCloudWorkspaceFollow,
  setTeamWorkspacesLiveForTests,
  useTeamWorkspacesLive
} from './team-workspaces-live'
import { resetCloudWorkspacesAvailabilityForFixtures } from './use-cloud-workspaces'
import { workspace } from './cloud-workspaces.test-fixture'

const list = vi.fn()
const follow = vi.fn()

beforeEach(() => {
  list.mockReset()
  list.mockResolvedValue({ ok: true, value: [workspace({ title: 'Checkout' })] })
  Object.assign(window, {
    api: { cloudWorkspaces: { available: async () => true, list, follow } }
  })
  resetCloudWorkspacesAvailabilityForFixtures()
})
afterEach(() => cleanup())

function Probe({ account, id }: { account: string | null; id: string }): React.JSX.Element {
  const live = useTeamWorkspacesLive(account)
  return <span data-testid={id}>{live ? live.map((w) => w.title).join(',') : 'none'}</span>
}

describe('useTeamWorkspacesLive (PARITY-FOLLOW)', () => {
  it('shares one team read between surfaces', async () => {
    const view = render(
      <>
        <Probe account="org:acme" id="a" />
        <Probe account="org:acme" id="b" />
      </>
    )
    await waitFor(() => expect(view.getByTestId('a').textContent).toBe('Checkout'))
    expect(view.getByTestId('b').textContent).toBe('Checkout')
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith({ scope: 'team', archived: 'exclude' })
  })

  it('reads nothing without a team account', () => {
    const view = render(<Probe account={null} id="a" />)
    expect(view.getByTestId('a').textContent).toBe('none')
    expect(list).not.toHaveBeenCalled()
  })

  it('shows a follow at once from the server answer, and leaves the list alone on a refusal', async () => {
    const w = workspace({ title: 'Checkout', following: false, followers: [] })
    setTeamWorkspacesLiveForTests('org:acme', [w])
    follow.mockResolvedValueOnce({ ok: true, value: { following: true, followers: ['user_ada'] } })
    expect(await setCloudWorkspaceFollow(w.id, true)).toBe(true)
    expect(follow).toHaveBeenCalledWith(w.id, true)
    follow.mockResolvedValueOnce({ ok: false, error: 'forbidden' })
    expect(await setCloudWorkspaceFollow(w.id, false)).toBe(false)
  })
})
