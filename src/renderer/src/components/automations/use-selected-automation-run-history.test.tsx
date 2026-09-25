// @vitest-environment happy-dom

/**
 * A refused history read is an answer too. It used to be dropped on the floor,
 * which left the previous automation's ID in place — so the pane showed zero
 * runs for a question the host never answered, and anything waiting on this
 * read waited forever.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { ownerKey } from '../../../../shared/automation-owner-key'
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
  it('reports the refusal instead of leaving the pane on the previous automation', async () => {
    mocks.dispatch.mockResolvedValue({
      ok: false,
      notice: { message: 'web-01 is not connected', recovery: 'reconnect', severity: 'failure' }
    })
    const input = makeInput()

    await render(input)

    expect(settled(input)).toEqual([
      {
        automationId: 'a-1',
        rowKey: DESKTOP_ROW.key,
        ownerKey: 'uncaptured',
        runs: [],
        notice: { message: 'web-01 is not connected', recovery: 'reconnect', severity: 'failure' }
      }
    ])
  })

  it('reports a blocked row rather than discarding its reason', async () => {
    mocks.dispatch.mockResolvedValue({
      ok: false,
      notice: {
        message: 'This automation has no host to run on.',
        recovery: null,
        severity: 'owner'
      }
    })
    const input = makeInput()

    await render(input)

    expect(settled(input)[0]?.notice?.severity).toBe('owner')
    expect(settled(input)[0]?.automationId).toBe('a-1')
  })

  it('settles a successful read with no notice', async () => {
    const runs: AutomationRun[] = [makeRun({ id: 'run-1', automationId: 'a-1' })]
    mocks.dispatch.mockResolvedValue({ ok: true, value: runs })
    const input = makeInput()

    await render(input)

    expect(settled(input)).toEqual([
      { automationId: 'a-1', rowKey: DESKTOP_ROW.key, ownerKey: 'uncaptured', runs, notice: null }
    ])
  })

  it('re-asks the host when the reload token changes, so a failure can be retried', async () => {
    mocks.dispatch.mockResolvedValue({
      ok: false,
      notice: { message: 'offline', recovery: 'retry', severity: 'failure' }
    })
    const input = makeInput()

    const rerender = await render(input)
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)

    mocks.dispatch.mockResolvedValue({ ok: true, value: [] })
    await rerender({ ...input, reloadToken: 1 })

    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
    expect(settled(input).at(-1)).toEqual({
      automationId: 'a-1',
      rowKey: DESKTOP_ROW.key,
      ownerKey: 'uncaptured',
      runs: [],
      notice: null
    })
  })

  it('names the owner the history was read under', async () => {
    mocks.dispatch.mockResolvedValue({ ok: true, value: [] })
    const owner: AutomationOwnerRef = {
      authority: { kind: 'runtime', environmentId: 'gpu', pairingRevision: 2 },
      selector: { kind: 'self' }
    }
    const input = makeInput({
      context: {
        capturedOwners: new Map([[DESKTOP_ROW.key, { owner, selector: { kind: 'self' } }]]),
        authority: { kind: 'desktop' }
      }
    })

    await render(input)

    // The ID alone is unique only inside one authority, so the outcome carries
    // the owner and the pane can refuse a result read for a different host.
    expect(settled(input).at(-1)?.ownerKey).toBe(ownerKey(owner))
  })

  it('clears the pane when nothing is selected', async () => {
    const input = makeInput({ selected: null })

    await render(input)

    expect(settled(input)).toEqual([
      { automationId: null, rowKey: null, ownerKey: null, runs: [], notice: null }
    ])
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})
