import { expect, it } from 'vitest'
import { dispatchHibernatedAgentWake } from '@/lib/agent-session/resume/hibernated-agent-wake-owners'
import { listenForHibernatedAgentWake } from './hibernated-agent-wake-listener'

const TAB = '00000000-2222-4222-8222-222222222222'
const leafOf = (index: number) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`

it.each([100, 1_000])('a wake for one pane of a %i-pane split reaches only that pane', (count) => {
  let visited = 0
  const bindings = new Map(
    Array.from({ length: count }, (_, index) => {
      const paneKey = `${TAB}:${leafOf(index)}`
      return [
        leafOf(index),
        {
          dispose: () => {},
          wakeHibernatedAgentIfArmed: (_claimed?: Set<string>, target?: string) => {
            visited += 1
            return target === paneKey ? `claim-${index}` : null
          }
        }
      ] as const
    })
  )
  const stop = listenForHibernatedAgentWake(
    'wt',
    TAB,
    () => bindings.values(),
    (leafId) => bindings.get(leafId)
  )
  try {
    const woken = new Set<string>()
    for (let wake = 0; wake < 10; wake += 1) {
      dispatchHibernatedAgentWake({
        worktreeId: 'wt',
        paneKey: `${TAB}:${leafOf(count - 1)}`,
        wokenClaimKeys: woken
      })
    }
    expect(visited).toBe(10)
    expect([...woken]).toEqual([`claim-${count - 1}`])
  } finally {
    stop()
  }
})
