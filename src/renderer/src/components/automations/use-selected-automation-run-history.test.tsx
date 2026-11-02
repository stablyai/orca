// @vitest-environment happy-dom

/** Settle refused history reads explicitly so previous selection cannot masquerade as zero runs and waiters always complete. */

import type * as AutomationRowActionDispatch from './automation-row-action-dispatch'
import { runtimeEnvironment } from '@/lib/editor-file-operation-owner-interpretation.spec'
import { act, startTransition, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { ownerKey } from '../../../../shared/automation-owner-key'
import { emitAutomationsChangedWindowEvent } from '@/lib/automations-changed-window-event'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  markRuntimeEnvironmentCompatible,
  clearRuntimeCompatibilityCache
} from '@/runtime/runtime-rpc-client'
import { makeAutomation, makeRun } from './automations-page-fixtures'
import { automationListRowKey, type AutomationListRow } from './automation-list-row-identity'
import * as automationHostClient from './automation-host-client'
import {
  useSelectedAutomationRunHistory,
  type SelectedAutomationRunHistoryInput,
  type SelectedAutomationRunHistoryOutcome
} from './use-selected-automation-run-history'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), callEnvironment: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-environment-call', () => ({
  callRuntimeEnvironmentWithRevision: (...args: unknown[]) => mocks.callEnvironment(...args)
}))

vi.mock('./automation-row-action-dispatch', () => ({
  dispatchAutomationRunHistory: (...args: unknown[]) => mocks.dispatch(...args)
}))

const actual = await vi.importActual<typeof AutomationRowActionDispatch>(
  './automation-row-action-dispatch'
)

const roots: Root[] = []
const originalRuntimeEnvironments = useAppStore.getState().runtimeEnvironments

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
  clearRuntimeCompatibilityCache()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState({ runtimeEnvironments: originalRuntimeEnvironments })
})

describe('useSelectedAutomationRunHistory', () => {
  it('keeps the committed owner when a replacement acquisition render is discarded', async () => {
    const owner: AutomationOwnerRef = {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 7 }
    }
    const replacement: AutomationOwnerRef = {
      ...owner,
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 8 }
    }
    const contextFor = (value: AutomationOwnerRef) => ({
      authority: value.authority,
      capturedOwners: new Map([[DESKTOP_ROW.key, { owner: value, selector: value.selector }]])
    })
    const input = makeInput({ acquisitionToken: 0, context: contextFor(owner) })
    const pending = Promise.withResolvers<void>()
    const attempted = vi.fn()
    mocks.dispatch.mockResolvedValue({ ok: true, value: [makeRun({ id: 'saved-run' })] })
    function InterruptedHarness(props: {
      input: SelectedAutomationRunHistoryInput
      suspend?: boolean
    }) {
      useSelectedAutomationRunHistory(props.input)
      if (props.suspend) {
        attempted()
        throw pending.promise
      }
      return null
    }
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    const content = (next: SelectedAutomationRunHistoryInput, suspend = false) => (
      <Suspense fallback={null}>
        <InterruptedHarness input={next} suspend={suspend} />
      </Suspense>
    )
    await act(async () => root.render(content(input)))
    await act(async () => {
      startTransition(() =>
        root.render(
          content({ ...input, context: contextFor(replacement), acquisitionToken: 1 }, true)
        )
      )
    })
    expect(attempted).toHaveBeenCalled()
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    await act(async () =>
      root.render(content({ ...input, context: contextFor(replacement), reloadToken: 1 }))
    )
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
    expect(
      mocks.dispatch.mock.calls.at(-1)?.[0].capturedOwners.get(DESKTOP_ROW.key)?.owner
    ).toEqual(owner)
    expect(settled(input).at(-1)?.ownerKey).toBe(ownerKey(owner))
  })
  it('retains a legacy acquisition origin when the current fallback host changes', async () => {
    mocks.dispatch.mockImplementation(actual.dispatchAutomationRunHistory)
    const environments = ['gpu', 'other'].map((id) => runtimeEnvironment(id, 4))
    // SAFETY: the hook and transport only read these environment identity fields.
    useAppStore.setState({
      runtimeEnvironments: environments
    })
    replaceRuntimeEnvironmentRevisions(environments)
    environments.forEach(({ id }) => markRuntimeEnvironmentCompatible(id))
    mocks.callEnvironment.mockResolvedValue({
      ok: true,
      result: { runs: [makeRun({ id: 'original-authority-run' })] }
    })
    const input = makeInput({ legacyTarget: () => ({ kind: 'environment', environmentId: 'gpu' }) })
    const rerender = await render(input)
    expect(mocks.callEnvironment.mock.calls.at(-1)?.[0].environmentId).toBe('gpu')
    await rerender({
      ...input,
      legacyTarget: () => ({ kind: 'environment', environmentId: 'other' }),
      reloadToken: 1
    })
    expect(mocks.callEnvironment.mock.calls.at(-1)?.[0].environmentId).toBe('gpu')
    expect(settled(input).at(-1)?.authority).toEqual({
      kind: 'runtime',
      environmentId: 'gpu',
      pairingRevision: 4
    })
  })
  it('pins a legacy history retry to its acquired runtime pairing through the actual RPC path', async () => {
    mocks.dispatch.mockImplementation(actual.dispatchAutomationRunHistory)
    const environments = [runtimeEnvironment('gpu', 4)]
    // SAFETY: this test supplies the only runtime identity fields read by the acquisition hook.
    useAppStore.setState({
      runtimeEnvironments: environments
    })
    replaceRuntimeEnvironmentRevisions(environments)
    markRuntimeEnvironmentCompatible('gpu')
    mocks.callEnvironment.mockResolvedValue({
      ok: true,
      result: { runs: [makeRun({ id: 'acquired-run' })] }
    })
    const input = makeInput({ legacyTarget: () => ({ kind: 'environment', environmentId: 'gpu' }) })
    const rerender = await render(input)
    expect(settled(input).at(-1)?.authority).toEqual({
      kind: 'runtime',
      environmentId: 'gpu',
      pairingRevision: 4
    })
    expect(mocks.callEnvironment.mock.calls.at(-1)?.[0].expectedEnvironmentPairingRevision).toBe(4)
    replaceRuntimeEnvironmentRevisions([{ id: 'gpu', createdAt: 1, pairingRevision: 5 }], {
      retired: ['gpu'],
      sameHost: []
    })
    await rerender({ ...input, reloadToken: 1 })
    const retries = mocks.callEnvironment.mock.calls.slice(1)
    expect(retries.every(([request]) => request.expectedEnvironmentPairingRevision === 4)).toBe(
      true
    )
  })
  it('keeps acquired owner and saved output across disappearance, errors and Retry until explicit reselect', async () => {
    const owner: AutomationOwnerRef = {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 7 }
    }
    const captured = { owner, selector: owner.selector }
    const original = [makeRun({ id: 'saved-old-run' })]
    mocks.dispatch.mockResolvedValue({ ok: true, value: original })
    const input = makeInput({
      acquisitionToken: 0,
      context: {
        authority: owner.authority,
        capturedOwners: new Map([[DESKTOP_ROW.key, captured]])
      }
    })
    const rerender = await render(input)
    const retained = settled(input).at(-1)!
    const replacement: AutomationOwnerRef = {
      ...owner,
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 8 }
    }
    const context = {
      authority: owner.authority,
      capturedOwners: new Map([
        [DESKTOP_ROW.key, { owner: replacement, selector: replacement.selector }]
      ])
    }
    mocks.dispatch.mockResolvedValue({
      ok: false,
      notice: { message: 'Offline', recovery: 'retry', severity: 'failure' }
    })
    await rerender({
      ...input,
      selected: null,
      selection: { automationId: DESKTOP_ROW.automation.id, rowKey: DESKTOP_ROW.key },
      retained,
      context,
      reloadToken: 1
    })
    expect(settled(input).at(-1)?.runs).toBe(original)
    expect(settled(input).at(-1)?.capturedOwner).toEqual(captured)
    expect(mocks.dispatch.mock.calls.at(-1)?.[0].capturedOwners.get(DESKTOP_ROW.key)).toEqual(
      captured
    )
    await rerender({ ...input, context, retained, reloadToken: 2 })
    expect(mocks.dispatch.mock.calls.at(-1)?.[0].capturedOwners.get(DESKTOP_ROW.key)).toEqual(
      captured
    )
    await rerender({ ...input, context, acquisitionToken: 1, reloadToken: 2 })
    expect(
      mocks.dispatch.mock.calls.at(-1)?.[0].capturedOwners.get(DESKTOP_ROW.key)?.owner
    ).toEqual(replacement)
  })
  it.each([5, 50])(
    'ignores %s unrelated publisher events for a captured runtime SSH history',
    async (size) => {
      const owner: AutomationOwnerRef = {
        authority: { kind: 'runtime', environmentId: 'gpu', pairingRevision: 4 },
        selector: { kind: 'ssh', targetId: 'box', targetGeneration: 7 }
      }
      const input = makeInput({
        context: {
          authority: owner.authority,
          capturedOwners: new Map([[DESKTOP_ROW.key, { owner, selector: owner.selector }]])
        }
      })
      mocks.dispatch.mockResolvedValue({ ok: true, value: [] })
      const rerender = await render(input)
      const before = mocks.dispatch.mock.calls.length
      const outcomes = settled(input).length
      for (let index = 0; index < size; index++) {
        await act(async () =>
          emitAutomationsChangedWindowEvent({
            ...(index % 2 ? { environmentId: 'other' } : { environmentId: 'gpu' }),
            selector: { kind: 'ssh', targetId: `unrelated-${index}` },
            reason: 'run'
          })
        )
        expect(mocks.dispatch).toHaveBeenCalledTimes(before)
        expect(settled(input)).toHaveLength(outcomes)
      }
      await act(async () => emitAutomationsChangedWindowEvent())
      expect(mocks.dispatch).toHaveBeenCalledTimes(before)
      const completed = [makeRun({ id: 'ssh-completed' })]
      mocks.dispatch.mockResolvedValue({ ok: true, value: completed })
      await act(async () =>
        emitAutomationsChangedWindowEvent({
          environmentId: 'gpu',
          selector: { kind: 'ssh', targetId: 'box' },
          reason: 'run'
        })
      )
      expect(mocks.dispatch).toHaveBeenCalledTimes(before + 1)
      expect(settled(input).at(-1)?.runs).toEqual(completed)
      expect(
        mocks.dispatch.mock.calls.at(-1)?.[0].capturedOwners.get(DESKTOP_ROW.key)?.owner
      ).toEqual(owner)
      await rerender({ ...input, context: { ...input.context } })
      expect(mocks.dispatch).toHaveBeenCalledTimes(before + 1)
      await act(async () => emitAutomationsChangedWindowEvent({ environmentId: 'gpu' }))
      expect(mocks.dispatch).toHaveBeenCalledTimes(before + 2)
    }
  )

  it('supersedes pending history on completion and keeps the event subscription after navigation is consumed', async () => {
    const pending = Promise.withResolvers<{ ok: true; value: AutomationRun[] }>()
    const finished = [
      makeRun({
        id: 'completed-with-saved-output',
        outputSnapshot: {
          format: 'plain_text',
          content: 'Latest exact answer',
          capturedAt: 3,
          truncated: false
        }
      })
    ]
    mocks.dispatch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ok: true, value: finished })
    const input = makeInput({ navigation: { automationId: 'a-1', runId: finished[0]!.id } })
    const rerender = await render(input)
    await act(async () => emitAutomationsChangedWindowEvent({ reason: 'run' }))
    expect(settled(input).at(-1)?.runs).toEqual(finished)
    await act(async () => pending.resolve({ ok: true, value: [makeRun({ id: 'obsolete' })] }))
    expect(settled(input)).toHaveLength(1)
    expect(settled(input).at(-1)?.runs).toEqual(finished)
    await rerender({ ...input, navigation: null })
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
    await act(async () => emitAutomationsChangedWindowEvent({ reason: 'run' }))
    expect(mocks.dispatch).toHaveBeenCalledTimes(3)
    expect(settled(input).at(-1)?.navigation).toBeNull()
    expect(settled(input).at(-1)?.runs).toEqual(finished)
  })

  it('keeps captured ownership on event retries and refuses a late answer after explicit replacement acquisition', async () => {
    const owner: AutomationOwnerRef = {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 7 }
    }
    const pending = Promise.withResolvers<{ ok: true; value: AutomationRun[] }>()
    const original = [makeRun({ id: 'saved-exact-old-run' })]
    mocks.dispatch
      .mockResolvedValueOnce({ ok: true, value: original })
      .mockReturnValueOnce(pending.promise)
    const input = makeInput({
      acquisitionToken: 0,
      context: {
        authority: owner.authority,
        capturedOwners: new Map([[DESKTOP_ROW.key, { owner, selector: owner.selector }]])
      }
    })
    const rerender = await render(input)
    const retained = settled(input).at(-1)!
    const event = { selector: { kind: 'ssh' as const, targetId: 'box' }, reason: 'run' as const }
    await act(async () => emitAutomationsChangedWindowEvent(event))
    const replacement: AutomationOwnerRef = {
      ...owner,
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 8 }
    }
    const context = {
      authority: owner.authority,
      capturedOwners: new Map([
        [DESKTOP_ROW.key, { owner: replacement, selector: replacement.selector }]
      ])
    }
    await rerender({ ...input, context, retained })
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
    mocks.dispatch.mockResolvedValueOnce({
      ok: false,
      notice: { message: 'Offline', recovery: 'retry', severity: 'failure' }
    })
    await act(async () => emitAutomationsChangedWindowEvent(event))
    expect(
      mocks.dispatch.mock.calls.at(-1)?.[0].capturedOwners.get(DESKTOP_ROW.key)?.owner
    ).toEqual(owner)
    expect(settled(input).at(-1)?.runs).toBe(original)
    expect(settled(input).at(-1)?.notice?.message).toBe('Offline')
    const fresh = [makeRun({ id: 'explicit-new-acquisition' })]
    mocks.dispatch.mockResolvedValueOnce({ ok: true, value: fresh })
    await rerender({ ...input, context, retained, acquisitionToken: 1 })
    expect(
      mocks.dispatch.mock.calls.at(-1)?.[0].capturedOwners.get(DESKTOP_ROW.key)?.owner
    ).toEqual(replacement)
    await act(async () =>
      pending.resolve({ ok: true, value: [makeRun({ id: 'late-old-incarnation' })] })
    )
    expect(settled(input).at(-1)?.runs).toEqual(fresh)
    expect(settled(input).at(-1)?.ownerKey).toBe(ownerKey(replacement))
  })

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
        authority: { kind: 'desktop' },
        navigation: null,
        reloadToken: 0,
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
      {
        automationId: 'a-1',
        rowKey: DESKTOP_ROW.key,
        ownerKey: 'uncaptured',
        authority: { kind: 'desktop' },
        navigation: null,
        reloadToken: 0,
        runs,
        notice: null
      }
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
      authority: { kind: 'desktop' },
      navigation: null,
      reloadToken: 1,
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

    // Carry owner identity with outcomes so the pane can reject a same-ID result from another host.
    expect(settled(input).at(-1)?.ownerKey).toBe(ownerKey(owner))
    expect(settled(input).at(-1)?.authority).toEqual(owner.authority)
    expect(mocks.dispatch.mock.calls[0][3]).toEqual(owner.authority)
  })

  it('keeps the requested overview host for a row without a captured owner', async () => {
    // SAFETY: this acquisition reads only the runtime's identity and pairing revision.
    useAppStore.setState({
      runtimeEnvironments: [runtimeEnvironment('gpu', 7)]
    })
    const runs = [makeRun()]
    const listRuns = vi
      .spyOn(automationHostClient, 'listAutomationRunsForTarget')
      .mockResolvedValueOnce(runs)
    mocks.dispatch.mockImplementationOnce(
      async (_context: unknown, _row: unknown, legacy: () => Promise<AutomationRun[]>) => ({
        ok: true,
        value: await legacy()
      })
    )
    const input = makeInput({
      navigation: { automationId: 'a-1', runId: null, hostId: 'runtime:gpu' }
    })

    try {
      await render(input)

      expect(listRuns).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'gpu' }, 'a-1', 7)
      expect(settled(input).at(-1)?.runs).toEqual(runs)
    } finally {
      listRuns.mockRestore()
    }
  })

  it('clears the pane when nothing is selected', async () => {
    const input = makeInput({ selected: null })

    await render(input)

    expect(settled(input)).toEqual([
      {
        automationId: null,
        rowKey: null,
        ownerKey: null,
        authority: null,
        navigation: null,
        reloadToken: 0,
        runs: [],
        notice: null
      }
    ])
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('refreshes each navigation and keeps its answer when navigation is consumed', async () => {
    mocks.dispatch.mockResolvedValue({ ok: true, value: [] })
    const input = makeInput()
    const rerender = await render(input)
    const navigation = { automationId: 'a-1', runId: 'run-27' }
    const runs = [makeRun({ id: navigation.runId })]
    mocks.dispatch.mockResolvedValue({ ok: true, value: runs })

    await rerender({ ...input, navigation })

    expect(settled(input).at(-1)?.runs).toEqual(runs)
    expect(settled(input).at(-1)?.navigation).toBe(navigation)
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)

    await rerender(input)
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)

    const repeatedNavigation = { ...navigation }
    await rerender({ ...input, navigation: repeatedNavigation })
    expect(mocks.dispatch).toHaveBeenCalledTimes(3)
    expect(settled(input).at(-1)?.navigation).toBe(repeatedNavigation)
  })

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
