// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { runtimeEnvironmentPairingChangedError } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import type * as RevisionModule from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { useSettingsCopy } from './use-settings-copy'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock(
  '@/runtime/rpc/environment-revisions/runtime-environment-revision',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RevisionModule>()),
    captureRuntimeEnvironmentRequestRevision: vi.fn()
  })
)

type CallOptions = { expectedEnvironmentPairingRevision?: number }
type Answer = (params: unknown, options?: CallOptions) => unknown
type Call = { side: string; method: string; params: unknown; options?: CallOptions }

/** Answers RPCs keyed by `local` or the environment id, then the method; records every call. */
function fakeRpc(answers: Record<string, Record<string, Answer>>): Call[] {
  const calls: Call[] = []
  vi.mocked(callRuntimeRpc).mockImplementation(async (target, method, params, options) => {
    const side = target.kind === 'local' ? 'local' : target.environmentId
    calls.push({ side, method, params, options })
    return answers[side]?.[method]?.(params, options)
  })
  return calls
}

const isWrite = (params: unknown): boolean =>
  typeof params === 'object' && params !== null && 'dryRun' in params && params.dryRun === false

describe('useSettingsCopy', () => {
  it('previews on the paired Orca, then sends exactly the previewed settings', async () => {
    let fontSize = 14
    const calls = fakeRpc({
      local: {
        'settings.exportPortable': () => ({
          settings: { terminalFontSize: fontSize },
          skipped: ['terminalThemeLight']
        })
      },
      work: {
        'settings.importPortable': () => ({ changed: ['terminalFontSize'], skipped: [] })
      }
    })
    const { result } = renderHook(() => useSettingsCopy('work'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.state.phase).toBe('ready'))
    expect(result.current.state).toMatchObject({
      preview: { changed: ['terminalFontSize'], notSent: ['terminalThemeLight'] }
    })

    fontSize = 20
    act(() => result.current.apply())
    await waitFor(() => expect(result.current.state.phase).toBe('applied'))
    expect(calls.map(({ side, method, params }) => [side, method, params])).toEqual([
      ['local', 'settings.exportPortable', undefined],
      ['work', 'settings.importPortable', { settings: { terminalFontSize: 14 }, dryRun: true }],
      ['work', 'settings.importPortable', { settings: { terminalFontSize: 14 }, dryRun: false }]
    ])
  })

  it('brings settings here and ignores the preview the direction switch replaced', async () => {
    let finishSend: (value: unknown) => void = () => {}
    const calls = fakeRpc({
      local: {
        'settings.exportPortable': () => new Promise((resolve) => (finishSend = resolve)),
        'settings.importPortable': () => ({ changed: ['theme'], skipped: ['uiLanguage'] })
      },
      work: {
        'settings.exportPortable': () => ({ settings: { theme: 'dark' }, skipped: [] }),
        'settings.importPortable': () => ({ changed: ['editorFontSize'], skipped: [] })
      }
    })
    const { result } = renderHook(() => useSettingsCopy('work'))
    act(() => result.current.start())
    act(() => result.current.chooseDirection('receive'))
    await waitFor(() => expect(result.current.state.phase).toBe('ready'))
    await act(async () => finishSend({ settings: { editorFontSize: 13 }, skipped: [] }))

    expect(result.current.direction).toBe('receive')
    expect(result.current.state).toMatchObject({
      preview: { changed: ['theme'], skipped: ['uiLanguage'] }
    })
    // The replaced check may still finish its dry run; it must not reach the dialog or write.
    expect(
      calls
        .filter(({ side, method }) => side === 'local' && method === 'settings.importPortable')
        .map(({ side, method, params }) => ({ side, method, params }))
    ).toEqual([
      {
        side: 'local',
        method: 'settings.importPortable',
        params: { settings: { theme: 'dark' }, dryRun: true }
      }
    ])
  })

  it('names a paired Orca that predates settings copy', async () => {
    fakeRpc({
      local: { 'settings.exportPortable': () => ({ settings: {}, skipped: [] }) },
      work: {
        'settings.importPortable': () => {
          throw new RuntimeRpcCallError({
            id: '1',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method: settings.importPortable' }
          })
        }
      }
    })
    const { result } = renderHook(() => useSettingsCopy('work'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({ unsupported: true })
  })

  it('writes nothing when the preview found nothing to change', async () => {
    const calls = fakeRpc({
      local: { 'settings.exportPortable': () => ({ settings: { theme: 'dark' }, skipped: [] }) },
      work: { 'settings.importPortable': () => ({ changed: [], skipped: [] }) }
    })
    const { result } = renderHook(() => useSettingsCopy('work'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.state.phase).toBe('ready'))
    act(() => result.current.apply())

    expect(result.current.state.phase).toBe('ready')
    expect(calls).not.toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ dryRun: false }) })
    )
  })

  it('stays open while the copy is being written, then closes', async () => {
    let finishWrite: (value: unknown) => void = () => {}
    fakeRpc({
      local: { 'settings.exportPortable': () => ({ settings: { theme: 'dark' }, skipped: [] }) },
      work: {
        'settings.importPortable': (params) =>
          isWrite(params)
            ? new Promise((resolve) => (finishWrite = resolve))
            : { changed: ['theme'], skipped: [] }
      }
    })
    const { result } = renderHook(() => useSettingsCopy('work'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.state.phase).toBe('ready'))
    act(() => result.current.apply())
    // Escape, an outside press or Cancel all call close: the write would finish unseen.
    act(() => result.current.close())
    expect(result.current.open).toBe(true)
    expect(result.current.state.phase).toBe('applying')

    await act(async () => finishWrite({ changed: ['theme'], skipped: [] }))
    expect(result.current.state.phase).toBe('applied')
    act(() => result.current.close())
    expect(result.current.open).toBe(false)
  })

  it('writes only to the pairing the preview checked, and asks again after a re-pair', async () => {
    let pairing = 3
    vi.mocked(captureRuntimeEnvironmentRequestRevision).mockImplementation(() => pairing)
    const calls = fakeRpc({
      local: { 'settings.exportPortable': () => ({ settings: { theme: 'dark' }, skipped: [] }) },
      work: {
        'settings.importPortable': (_params, options) => {
          // A paired Orca refuses a call pinned to an older pairing, as main does.
          if (options?.expectedEnvironmentPairingRevision !== pairing) {
            throw runtimeEnvironmentPairingChangedError()
          }
          return { changed: ['theme'], skipped: [] }
        }
      }
    })
    const { result } = renderHook(() => useSettingsCopy('work'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.state.phase).toBe('ready'))

    pairing = 4
    act(() => result.current.apply())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({ pairingChanged: true, unsupported: false })
    expect(calls.filter(({ params }) => isWrite(params)).map(({ options }) => options)).toEqual([
      { expectedEnvironmentPairingRevision: 3 }
    ])

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.state.phase).toBe('ready'))
    act(() => result.current.apply())
    await waitFor(() => expect(result.current.state.phase).toBe('applied'))
    vi.mocked(captureRuntimeEnvironmentRequestRevision).mockReset()
  })
})
