import { expect, it } from 'vitest'
import {
  dispatchHibernatedAgentWake,
  registerHibernatedAgentWakeOwner
} from './hibernated-agent-wake-owners'

const LEAF_ID = '00000000-1111-4111-8111-111111111111'
const tabId = (index: number) => `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`

it.each([100, 1_000])(
  'a pane wake reaches only its own tab among %i mounted tabs, and a burst stays linear',
  (count) => {
    let callbacks = 0
    const woken: string[] = []
    const releases = Array.from({ length: count }, (_, index) =>
      registerHibernatedAgentWakeOwner({
        worktreeId: index % 2 === 0 ? 'wt-even' : 'wt-odd',
        tabId: tabId(index),
        wake: () => {
          callbacks += 1
          woken.push(tabId(index))
        }
      })
    )

    dispatchHibernatedAgentWake({ worktreeId: 'wt-even', paneKey: `${tabId(0)}:${LEAF_ID}` })
    expect([callbacks, woken]).toEqual([1, [tabId(0)]])

    callbacks = 0
    for (let index = 0; index < count; index += 1) {
      dispatchHibernatedAgentWake({
        worktreeId: index % 2 === 0 ? 'wt-even' : 'wt-odd',
        paneKey: `${tabId(index)}:${LEAF_ID}`
      })
    }
    expect(callbacks).toBe(count)

    // A pane wake naming another workspace reaches nobody; a workspace wake reaches only its tabs.
    callbacks = 0
    dispatchHibernatedAgentWake({ worktreeId: 'wt-odd', paneKey: `${tabId(0)}:${LEAF_ID}` })
    dispatchHibernatedAgentWake({ worktreeId: 'wt-even' })
    expect(callbacks).toBe(count / 2)

    for (const release of releases) {
      release()
    }
    callbacks = 0
    dispatchHibernatedAgentWake({ worktreeId: 'wt-even' })
    dispatchHibernatedAgentWake({ worktreeId: 'wt-even', paneKey: `${tabId(0)}:${LEAF_ID}` })
    expect(callbacks).toBe(0)
  }
)
