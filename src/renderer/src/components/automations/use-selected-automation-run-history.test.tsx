// @vitest-environment happy-dom

/** Settle refused history reads explicitly so previous selection cannot masquerade as zero runs and waiters always complete. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'

import { makeAutomation, makeRun } from './automations-page-fixtures'
import { automationListRowKey, type AutomationListRow } from './automation-list-row-identity'

import {
  useSelectedAutomationRunHistory,
  type SelectedAutomationRunHistoryInput,
  type SelectedAutomationRunHistoryOutcome
} from './use-selected-automation-run-history'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }))

vi.mock('./automation-row-action-dispatch', () => ({
  dispatchAutomationRunHistory: (...args: unknown[]) => mocks.dispatch(...args)
}))

const roots: Root[] = []

const DESKTOP_ROW: AutomationListRow = {
  key: automationListRowKey('host:desktop|self', 'a-1'),
  automation: makeAutomation({ id: 'a-1' }),
  hostLabel: 'This computer',
  usageSummary: null
}

function Harness(props: { input: SelectedAutomationRunHistoryInput }): null {
  useSelectedAutomationRunHistory(props.input)
  return null
}

function makeInput(
  overrides: Partial<SelectedAutomationRunHistoryInput> = {}
): SelectedAutomationRunHistoryInput {
  return {
    selected: DESKTOP_ROW,
    context: { capturedOwners: new Map(), authority: { kind: 'desktop' } },
    legacyTarget: () => ({ kind: 'local' }),
    navigation: null,
    reloadToken: 0,
    onSettled: vi.fn(),
    ...overrides
  }
}

async function render(
  input: SelectedAutomationRunHistoryInput
): Promise<(next: SelectedAutomationRunHistoryInput) => Promise<void>> {
  const container = document.createElement('div')
  const root = createRoot(container)
  roots.push(root)
  const rerender = async (next: SelectedAutomationRunHistoryInput): Promise<void> => {
    await act(async () => {
      root.render(<Harness input={next} />)
    })
  }
  await rerender(input)
  return rerender
}

function settled(input: SelectedAutomationRunHistoryInput): SelectedAutomationRunHistoryOutcome[] {
  return (input.onSettled as ReturnType<typeof vi.fn>).mock.calls.map(
    ([outcome]) => outcome as SelectedAutomationRunHistoryOutcome
  )
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
})

describe('useSelectedAutomationRunHistory', () => {
  it('ignores a previous navigation that finishes after a newer navigation', async () => {
    const obsolete = Promise.withResolvers<{ ok: true; value: AutomationRun[] }>()
    const current = Promise.withResolvers<{ ok: true; value: AutomationRun[] }>()
    mocks.dispatch.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise)
    const firstNavigation = { automationId: 'a-1', runId: 'run-26' }
    const input = makeInput({ navigation: firstNavigation })
    const rerender = await render(input)
    const secondNavigation = { automationId: 'a-1', runId: 'run-27' }
    await rerender({ ...input, navigation: secondNavigation })

    await act(async () => {
      current.resolve({ ok: true, value: [makeRun({ id: secondNavigation.runId })] })
    })
    await act(async () => {
      obsolete.resolve({ ok: true, value: [makeRun({ id: firstNavigation.runId })] })
    })

    expect(settled(input)).toHaveLength(1)
    expect(settled(input)[0]?.navigation).toBe(secondNavigation)
    expect(settled(input)[0]?.runs[0]?.id).toBe('run-27')
  })

  it('refreshes a reselected row after an intervening read was cancelled', async () => {
    const obsolete = Promise.withResolvers<{ ok: true; value: AutomationRun[] }>()
    const oldRun = makeRun({ id: 'run-26' })
    const freshRun = makeRun({ id: 'run-27' })
    mocks.dispatch
      .mockResolvedValueOnce({ ok: true, value: [oldRun] })
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce({ ok: true, value: [freshRun, oldRun] })
    const input = makeInput()
    const rerender = await render(input)

    await rerender({
      ...input,
      selected: {
        ...DESKTOP_ROW,
        key: automationListRowKey('host:desktop|self', 'a-2'),
        automation: makeAutomation({ id: 'a-2' })
      }
    })
    await rerender(input)
    await act(async () => {
      obsolete.resolve({ ok: true, value: [makeRun({ automationId: 'a-2' })] })
    })

    expect(mocks.dispatch).toHaveBeenCalledTimes(3)
    expect(settled(input).at(-1)?.runs).toEqual([freshRun, oldRun])
  })
})
