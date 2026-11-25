// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { SharedBotHostsState } from '../../../../../shared/bots/shared-bot-hosts'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { useBotShareLine } from './BotShareMark'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the share line reads only these fields.
const OWNED = {
  id: 'bot-1',
  hostId: 'local',
  shares: [
    { kind: 'account', shareId: 's1', accountId: 'a1', name: 'Mara', email: 'm@x.dev', addedAt: 1 }
  ]
} as unknown as Bot

let changed: (state: SharedBotHostsState) => void = () => {}
let uninstall = (): void => {}

function ShareLine(): React.JSX.Element {
  return <p>{useBotShareLine(OWNED) ?? 'none'}</p>
}

/** The real catalog, as main says whether this account's Orca Cloud takes shares. */
async function cloudTakesShares(sharing: boolean | null): Promise<void> {
  Reflect.set(window, 'api', {
    sharedBotHosts: {
      list: async () => ({ hosts: [], sharing }),
      onChanged: (listener: typeof changed) => {
        changed = listener
        return () => {}
      }
    }
  })
  await act(async () => {
    uninstall = installSharedBotHostCatalog()
  })
}

afterEach(() => {
  cleanup()
  uninstall()
  Reflect.deleteProperty(window, 'api')
})

describe('the owner’s share line', () => {
  it('names the people only while the cloud takes shares', async () => {
    await cloudTakesShares(true)
    render(<ShareLine />)
    expect(screen.getByText('Shared with Mara')).toBeTruthy()
    act(() => changed({ hosts: [], sharing: false }))
    expect(screen.getByText('none')).toBeTruthy()
    act(() => changed({ hosts: [], sharing: null }))
    expect(screen.getByText('none')).toBeTruthy()
    act(() => changed({ hosts: [], sharing: true }))
    expect(screen.getByText('Shared with Mara')).toBeTruthy()
  })
})
