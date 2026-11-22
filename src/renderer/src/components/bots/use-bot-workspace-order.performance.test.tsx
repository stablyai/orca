// @vitest-environment happy-dom
// Guards the bot list's Smart sort: every bot rebuilt the fleet-wide tab and status lookups on each re-rank.
import { act, render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { useBotWorkspaceOrder } from './use-bot-workspace-order'

const WORKSPACES = 2_000
const WORKERS_PER_BOT = 20

function BotList({ workers }: { workers: Worktree[] }) {
  return <span>{useBotWorkspaceOrder(workers).length}</span>
}

/** Fleet-wide tab walks per re-rank with `bots` bots mounted, after their Smart order went live. */
function fleetWalks(bots: number): { inputChanged: number; inputsSame: number } {
  let walks = 0
  const fleetTabs = () => {
    const tabs: Record<string, TerminalTab[]> = {}
    for (let i = 0; i < WORKSPACES; i++) {
      tabs[`w${i}`] = [makeTab({ id: `t${i}`, worktreeId: `w${i}` })]
    }
    return new Proxy(tabs, {
      ownKeys(target) {
        walks++
        return Reflect.ownKeys(target)
      }
    })
  }
  // A live PTY ends the cold phase, so later re-ranks run the live Smart sort.
  useAppStore.setState({ tabsByWorktree: fleetTabs(), ptyIdsByTabId: { t0: ['pty-0'] } })
  const lists = Array.from({ length: bots }, (_, bot) =>
    Array.from({ length: WORKERS_PER_BOT }, (_, i) => {
      const id = `w${bot * WORKERS_PER_BOT + i}`
      return makeWorktree({ id, repoId: 'r', displayName: id })
    })
  )
  const view = render(
    <>
      {lists.map((workers, bot) => (
        <BotList key={bot} workers={workers} />
      ))}
    </>
  )
  walks = 0
  act(() =>
    useAppStore.setState((s) => ({
      tabsByWorktree: fleetTabs(),
      settledSortEpoch: s.settledSortEpoch + 1
    }))
  )
  const inputChanged = walks
  walks = 0
  act(() => useAppStore.setState((s) => ({ settledSortEpoch: s.settledSortEpoch + 1 })))
  const inputsSame = walks
  view.unmount()
  return { inputChanged, inputsSame }
}

it('walks the fleet once per input change, however many bots re-rank', () => {
  // Store writes walk the tabs too; subtract that so only the bots' walks count.
  const store = fleetWalks(0)
  const extra = (bots: number) => {
    const walks = fleetWalks(bots)
    return {
      inputChanged: walks.inputChanged - store.inputChanged,
      inputsSame: walks.inputsSame - store.inputsSame
    }
  }
  expect(extra(1)).toEqual({ inputChanged: 1, inputsSame: 0 })
  expect(extra(10)).toEqual({ inputChanged: 1, inputsSame: 0 })
})
