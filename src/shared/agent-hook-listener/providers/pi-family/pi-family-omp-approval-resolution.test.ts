import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizePiCompatibleEvent } from './pi-family-events'

// #38570: an auto-learn capture approval resolves after agent_end, and no later end follows.
it('maps an omp approval resolved outside a turn to done', () => {
  const resolve = (isIdle: boolean) =>
    normalizePiCompatibleEvent(
      createHookListenerState(),
      'omp',
      'tool_approval_resolved',
      '',
      'pane',
      {
        tool_name: 'manage_skill',
        approved: true,
        is_idle: isIdle
      }
    )
  expect(resolve(false)).toMatchObject({ state: 'working' })
  expect(resolve(true)).toMatchObject({ state: 'done' })
})
