// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { automationOwnerEnvironment } from '../hosts/automation-owner.test-fixture'
import { makeAutomation, makeRun } from '../automations-page-fixtures'
import {
  useSelectedAutomationRunHistory,
  type SelectedAutomationRunHistoryInput,
  type SelectedAutomationRunHistoryOutcome
} from './use-selected-automation-run-history'

vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))
afterEach(cleanup)

it('reacquires a selected row under a new captured owner without reselection or a token change', async () => {
  const owner = (revision: number) => ({
    authority: { kind: 'runtime' as const, environmentId: 'e', pairingRevision: revision },
    selector: { kind: 'self' as const }
  })
  const environment = automationOwnerEnvironment('e', 1)
  useAppStore.setState({ runtimeEnvironments: [environment] })
  replaceRuntimeEnvironmentRevisions([environment], { retired: [], sameHost: [] })
  let oldReply!: (value: unknown) => void
  const old = new Promise<unknown>((resolve) => {
    oldReply = resolve
  })
  const acquired: number[] = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      runtime: {},
      runtimeEnvironments: {
        call: async (request: { method: string; expectedEnvironmentPairingRevision?: number }) => {
          if (request.method === 'status.get') {
            return createCompatibleRuntimeStatusResponse('origin')
          }
          const revision = request.expectedEnvironmentPairingRevision ?? -1
          acquired.push(revision)
          return {
            ok: true,
            result:
              revision === 1 ? await old : { runs: [makeRun({ id: 'fresh' })], nextCursor: null }
          }
        }
      }
    }
  })
  const row = {
    key: 'remote-a',
    automation: makeAutomation({ id: 'a' }),
    hostLabel: 'Remote',
    usageSummary: null
  }
  const outcomes: SelectedAutomationRunHistoryOutcome[] = []
  const input: SelectedAutomationRunHistoryInput = {
    selected: row,
    context: {
      authority: owner(1).authority,
      capturedOwners: new Map([[row.key, { owner: owner(1), selector: owner(1).selector }]])
    },
    navigation: null,
    reloadToken: 0,
    acquisitionToken: 0,
    legacyTarget: () => null,
    onSettled: (outcome) => outcomes.push(outcome)
  }
  const view = renderHook((props) => useSelectedAutomationRunHistory(props), {
    initialProps: input
  })
  await waitFor(() => expect(acquired).toEqual([1]))
  const next = automationOwnerEnvironment('e', 2)
  await act(async () => {
    useAppStore.setState({ runtimeEnvironments: [next] })
    replaceRuntimeEnvironmentRevisions([next], { retired: ['e'], sameHost: [] })
  })
  view.rerender({
    ...input,
    context: {
      authority: owner(2).authority,
      capturedOwners: new Map([[row.key, { owner: owner(2), selector: owner(2).selector }]])
    },
    navigation: { automationId: 'a', runId: 'fresh', hostId: 'runtime:e', owner: owner(2) }
  })
  await waitFor(() => expect(outcomes.at(-1)?.runs[0]?.id).toBe('fresh'))
  await act(async () => oldReply({ runs: [makeRun({ id: 'obsolete' })], nextCursor: null }))
  expect(acquired).toEqual([1, 2])
  expect(outcomes.at(-1)?.runs[0]?.id).toBe('fresh')
})

it('does not restart the selected twin for a checking handoff and ignores its late history after admitted selection', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { runtime: {}, runtimeEnvironments: {} }
  })
  const desktop = { authority: { kind: 'desktop' }, selector: { kind: 'self' } } as const
  const remote = {
    authority: { kind: 'runtime', environmentId: 'e', pairingRevision: 1 },
    selector: { kind: 'self' }
  } as const
  const environment = automationOwnerEnvironment('e', 2)
  useAppStore.setState({ runtimeEnvironments: [environment] })
  replaceRuntimeEnvironmentRevisions([environment], {
    retired: [],
    sameHost: [],
    pending: [{ id: 'e', fromRevision: 1 }]
  })
  let localReply!: (value: unknown) => void
  const localHeld = new Promise<unknown>((resolve) => {
    localReply = resolve
  })
  const calls: string[] = []
  window.api.runtime.call = async () => {
    calls.push('local')
    return { id: 'fixture', _meta: { runtimeId: 'origin' }, ok: true, result: await localHeld }
  }
  window.api.runtimeEnvironments = {
    ...window.api.runtimeEnvironments,
    call: async (request) => {
      if (request.method === 'status.get') {
        return createCompatibleRuntimeStatusResponse('origin')
      }
      calls.push('remote')
      return {
        id: 'fixture',
        _meta: { runtimeId: 'origin' },
        ok: true,
        result: { runs: [makeRun({ id: 'remote-run', automationId: 'a' })], nextCursor: null }
      }
    }
  }
  const automation = makeAutomation({ id: 'a' })
  const localRow = { key: 'local-a', automation, hostLabel: 'Local', usageSummary: null }
  const remoteRow = { ...localRow, key: 'remote-a', hostLabel: 'Remote' }
  const outcomes: SelectedAutomationRunHistoryOutcome[] = []
  const input: SelectedAutomationRunHistoryInput = {
    selected: localRow,
    context: {
      authority: desktop.authority,
      capturedOwners: new Map([[localRow.key, { owner: desktop, selector: desktop.selector }]])
    },
    navigation: null,
    reloadToken: 0,
    legacyTarget: () => null,
    onSettled: (outcome) => outcomes.push(outcome)
  }
  const view = renderHook((props) => useSelectedAutomationRunHistory(props), {
    initialProps: input
  })
  await waitFor(() => expect(calls).toEqual(['local']))
  const navigation = { automationId: 'a', runId: 'remote-run', hostId: 'runtime:e', owner: remote }
  view.rerender({ ...input, navigation })
  await act(async () => {})
  expect(calls).toEqual(['local'])
  await act(async () =>
    replaceRuntimeEnvironmentRevisions([environment], {
      retired: [],
      sameHost: [{ id: 'e', fromRevision: 1, toRevision: 2 }]
    })
  )
  expect(calls).toEqual(['local'])
  view.rerender({
    ...input,
    selected: remoteRow,
    navigation,
    context: {
      authority: remote.authority,
      capturedOwners: new Map([[remoteRow.key, { owner: remote, selector: remote.selector }]])
    }
  })
  await waitFor(() => expect(outcomes.at(-1)?.runs[0]?.id).toBe('remote-run'))
  await act(async () =>
    localReply({ runs: [makeRun({ id: 'local-run', automationId: 'a' })], nextCursor: null })
  )
  expect(calls).toEqual(['local', 'remote'])
  expect(outcomes.at(-1)).toMatchObject({
    rowKey: 'remote-a',
    authority: { kind: 'runtime', environmentId: 'e' },
    navigation: { runId: 'remote-run' }
  })
})
