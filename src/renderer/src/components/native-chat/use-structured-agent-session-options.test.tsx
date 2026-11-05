// @vitest-environment happy-dom
import {
  mocks,
  answer,
  mutateWith,
  PROVISIONAL,
  ATTACHED,
  REOPENED,
  renderOptions,
  descriptor,
  currentValue,
  HOST_CATALOG,
  tick
} from './use-structured-agent-session-options.test-fixture'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'

import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
describe('useStructuredAgentSessionOptions', () => {
  beforeEach(() => {
    mocks.sendSelection = false
    forgetStructuredSessionSelection('session-1')
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    mocks.toastError.mockReset()
    mocks.coherentCatalog = false
    resetHostModelCatalogSnapshotsForTests()
  })

  it('keeps the latest dependent menu after same-stamp receipts and an older delayed answer', async () => {
    const menu = (model: string, effort?: string): AgentSessionOptionsResult => ({
      models: ['family', 'newer'].map((id) => ({
        id,
        label: id,
        isDefault: false,
        effortsKnown: id === model && !!effort ? undefined : (false as const),
        efforts:
          id === model && effort ? [effort, 'off'].map((value) => ({ value, label: value })) : []
      })),
      current: { model, ...(effort ? { effort } : {}) }
    })
    const initial = { ...menu('family'), acceptsImages: true }
    const older = Promise.withResolvers<AgentSessionOptionsResult>()
    const latest = Promise.withResolvers<AgentSessionOptionsResult>()
    let reads = 0
    answer({
      options: () =>
        [Promise.resolve(initial), older.promise, latest.promise][reads++] ?? latest.promise
    })
    const { mutate, calls } = mutateWith(async () => null)
    calls
      .mockResolvedValueOnce({ options: { model: 'family' } })
      .mockResolvedValue({ options: { model: 'newer' } })
    const { result, rerender, unmount } = renderOptions(
      { ...REOPENED, agent: 'antigravity' },
      mutate
    )
    await waitFor(() => expect(currentValue(result.current.optionSnapshot, 'model')).toBe('family'))
    expect(descriptor(result.current.optionSnapshot, 'effort')).toBeUndefined()
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'family')).toBe(true)
    })
    await waitFor(() => expect(reads).toBe(2))
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'newer')).toBe(true)
    })
    expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
    expect(descriptor(result.current.optionSnapshot, 'effort')).toBeUndefined()
    // Returning to the view starts a current reader while the superseded response is still in flight.
    rerender({ ...REOPENED, agent: 'antigravity', hidden: true })
    rerender({ ...REOPENED, agent: 'antigravity' })
    await waitFor(() => expect(reads).toBe(3))
    await act(async () => latest.resolve({ ...menu('newer', 'high'), acceptsImages: true }))
    await waitFor(() => expect(currentValue(result.current.optionSnapshot, 'effort')).toBe('high'))
    await act(async () => older.resolve({ ...menu('family', 'low'), acceptsImages: false }))
    expect(result.current.acceptsImages).toBe(true)
    expect(currentValue(result.current.optionSnapshot, 'model')).toBe('newer')
    expect(descriptor(result.current.optionSnapshot, 'effort')).toMatchObject({
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'high',
        choices: [{ value: 'high' }, { value: 'off' }]
      }
    })
    unmount()
  })

  describe('while the launch is provisional', () => {
    it('keeps the host catalog default through attach instead of blanking it', async () => {
      // Only the first catalog read answers; the re-read at the new fence never does.
      let catalogReads = 0
      answer({
        modelCatalog: () =>
          ++catalogReads === 1 ? Promise.resolve(HOST_CATALOG) : new Promise(() => {})
      })
      const { result, rerender, unmount } = renderOptions(
        PROVISIONAL,
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      )
      rerender(ATTACHED)
      expect(catalogReads).toBe(2)
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      unmount()
    })
  })

  describe('before the provider starts', () => {
    // A started host knows the model selected by Claude settings/environment.
    const CLAUDE_STARTED = {
      models: [
        { id: 'opus[1m]', label: 'Opus (1M context)', isDefault: true, efforts: [] },
        { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }
      ],
      current: { model: 'haiku' }
    }
    const optionReads = (): number =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.options').length

    it('shows the model a new chat will run once its provider starts, not a seed default', async () => {
      answer({ options: () => Promise.resolve(CLAUDE_STARTED) })
      const starting = { ...ATTACHED, agent: 'claude' as const, providerStarting: true }
      const { result, rerender, unmount } = renderOptions(
        starting,
        mutateWith(async () => null).mutate
      )
      await tick()
      expect(optionReads()).toBe(0)
      expect(currentValue(result.current.optionSnapshot, 'model')).toBeNull()

      rerender({ ...starting, providerStarting: false })
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('haiku')
      )
      expect(descriptor(result.current.optionSnapshot, 'model')?.valueSource).toBe('dispatched')
      expect(optionReads()).toBe(1)
      unmount()
    })
  })
})
