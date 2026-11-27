// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useOptInOnlyExperimentRows } from './use-opt-in-only-experiment-rows'

type Props = { dashboard: boolean; attention: boolean; unlocked: boolean }

function visit(initial: Props) {
  return renderHook(
    ({ dashboard, attention, unlocked }: Props) =>
      useOptInOnlyExperimentRows(
        {
          experimentalAgentDashboardPopout: dashboard,
          experimentalTerminalAttention: attention
        },
        unlocked
      ),
    { initialProps: initial }
  )
}

it('keeps a switched-off row for the rest of the Settings visit, then drops it next visit', () => {
  const first = visit({ dashboard: false, attention: true, unlocked: false })
  expect(first.result.current).toEqual({ agentDashboard: false, terminalAttention: true })

  first.rerender({ dashboard: false, attention: false, unlocked: false })
  expect(first.result.current.terminalAttention).toBe(true)
  first.unmount()

  const next = visit({ dashboard: false, attention: false, unlocked: false })
  expect(next.result.current).toEqual({ agentDashboard: false, terminalAttention: false })
})

it('latches a row turned on mid-visit, so re-locking hidden experiments does not strand it', () => {
  const settings = visit({ dashboard: false, attention: false, unlocked: true })
  expect(settings.result.current).toEqual({ agentDashboard: true, terminalAttention: true })

  settings.rerender({ dashboard: true, attention: false, unlocked: true })
  settings.rerender({ dashboard: false, attention: false, unlocked: false })
  expect(settings.result.current).toEqual({ agentDashboard: true, terminalAttention: false })
})
