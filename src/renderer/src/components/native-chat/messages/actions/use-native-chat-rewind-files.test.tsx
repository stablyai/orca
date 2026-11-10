// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ error: vi.fn(), message: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import { useNativeChatRewind } from './use-native-chat-rewind'
import type { NativeChatCheckpointClient } from './native-chat-rewind-files'
import type { AgentSessionCheckpointPreview } from '../../../../../../shared/agent-session/lifecycle/agent-session-checkpoint'

type Input = Parameters<typeof useNativeChatRewind>[0]

afterEach(cleanup)
beforeEach(() => {
  toast.error.mockReset()
  toast.success.mockReset()
})

const item = (itemId: string, sequence: number): AgentJournalRenderItem => ({
  itemId,
  sequence,
  revision: 1,
  observedAt: sequence,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }
})
const done = { kind: 'done' as const, value: { itemId: 'user', epoch: 'new' } }

function client(preview: AgentSessionCheckpointPreview) {
  const restored = { changedFiles: 3, headMoved: false, undoId: '1-abcdef01' }
  return {
    preview: vi.fn<NativeChatCheckpointClient['preview']>().mockResolvedValue(preview),
    restore: vi.fn<NativeChatCheckpointClient['restore']>().mockResolvedValue(restored),
    undo: vi.fn<NativeChatCheckpointClient['undo']>().mockResolvedValue(restored)
  }
}

function input(checkpoints?: NativeChatCheckpointClient): Input & {
  send: ReturnType<typeof vi.fn>
} {
  return {
    sessionId: 'session',
    capturePresentation: () => () => true,
    state: {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'old',
      fence: 1,
      status: 'ready' as const,
      cursor: { epoch: 'old', sequence: 11 },
      items: [item('user', 10), item('later', 11)]
    },
    support: { supported: true as const },
    blocked: false,
    send: vi.fn().mockResolvedValue(done),
    ...(checkpoints ? { checkpoints } : {})
  }
}

/** Confirms the prompt, ticking or unticking its files option, and records what it showed. */
function answer(restoreFiles: boolean | 'default', shown: ConfirmationDialogOptions[]) {
  return vi.fn(async (options: ConfirmationDialogOptions) => {
    shown.push(options)
    options.option?.onConfirmed(
      restoreFiles === 'default' ? options.option.defaultChecked : restoreFiles
    )
    return true
  })
}

describe('rewind with file restore', () => {
  it('offers restoring files, on by default, with the count, and restores after the chat rewound', async () => {
    const checkpoints = client({
      available: true,
      changedFiles: 3,
      headMoved: true,
      createdAt: 1
    })
    const props = input(checkpoints)
    const view = renderHook(() => useNativeChatRewind(props))
    const shown: ConfirmationDialogOptions[] = []
    await act(() => view.result.current.request('user', answer('default', shown)))
    expect(checkpoints.preview).toHaveBeenCalledWith('user')
    expect(shown[0]?.option).toMatchObject({
      label: 'Also restore 3 changed files',
      defaultChecked: true
    })
    expect(shown[0]?.option?.detail).toContain('Later changes are discarded')
    expect(shown[0]?.option?.uncheckedDetail).toBe('Files on disk stay as they are.')
    expect(shown[0]?.option?.detail).toContain('Commits made since then stay on the branch')
    expect(shown[0]?.description).not.toContain('File changes on disk are kept')
    await vi.waitFor(() => expect(checkpoints.restore).toHaveBeenCalledWith('user'))
    expect(props.send.mock.invocationCallOrder[0]).toBeLessThan(
      checkpoints.restore.mock.invocationCallOrder[0]!
    )
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.success.mock.calls[0]?.[0]).toBe('Restored 3 files')
    const undo = toast.success.mock.calls[0]?.[1]?.action
    expect(undo.label).toBe('Undo')
    undo.onClick()
    await vi.waitFor(() => expect(checkpoints.undo).toHaveBeenCalledWith('1-abcdef01'))
  })

  it('disables restoring while an agent works in the workspace, and never restores then', async () => {
    const checkpoints = client({
      available: true,
      changedFiles: 2,
      headMoved: false,
      createdAt: 1,
      busy: true
    })
    const shown: ConfirmationDialogOptions[] = []
    const view = renderHook(() => useNativeChatRewind(input(checkpoints)))
    await act(() => view.result.current.request('user', answer(true, shown)))
    expect(shown[0]?.option).toMatchObject({
      disabled: true,
      defaultChecked: false,
      detail: "Files can't be restored while the agent is working."
    })
    await act(async () => {})
    expect(checkpoints.restore).not.toHaveBeenCalled()
  })

  it('keeps files when the box is unticked', async () => {
    const checkpoints = client({ available: true, changedFiles: 2, headMoved: false, createdAt: 1 })
    const view = renderHook(() => useNativeChatRewind(input(checkpoints)))
    await act(() => view.result.current.request('user', answer(false, [])))
    await act(async () => {})
    expect(checkpoints.restore).not.toHaveBeenCalled()
  })

  it('never restores files when the chat rewind did not go through', async () => {
    const checkpoints = client({ available: true, changedFiles: 2, headMoved: false, createdAt: 1 })
    const props = input(checkpoints)
    props.send.mockResolvedValue({
      kind: 'not-done',
      notice: '',
      failure: { kind: 'refused', code: 'x', details: { rewindReason: 'busy' } }
    })
    const view = renderHook(() => useNativeChatRewind(props))
    await act(() => view.result.current.request('user', answer(true, [])))
    await act(async () => {})
    expect(checkpoints.restore).not.toHaveBeenCalled()
  })

  it('keeps the old wording when there is no snapshot or no host support', async () => {
    for (const checkpoints of [client({ available: false, reason: 'none' }), undefined]) {
      const shown: ConfirmationDialogOptions[] = []
      const view = renderHook(() => useNativeChatRewind(input(checkpoints)))
      await act(() => view.result.current.request('user', answer(true, shown)))
      expect(shown[0]?.option).toBeUndefined()
      expect(shown[0]?.description).toContain('File changes on disk are kept')
      view.unmount()
    }
  })

  it('says files already match when nothing changed since the message', async () => {
    const shown: ConfirmationDialogOptions[] = []
    const checkpoints = client({ available: true, changedFiles: 0, headMoved: false, createdAt: 1 })
    const view = renderHook(() => useNativeChatRewind(input(checkpoints)))
    await act(() => view.result.current.request('user', answer(true, shown)))
    expect(shown[0]?.option).toBeUndefined()
    expect(shown[0]?.description).toContain('Files on disk already match this message.')
  })

  it('reports a refused restore without claiming files changed', async () => {
    const checkpoints = client({ available: true, changedFiles: 1, headMoved: false, createdAt: 1 })
    checkpoints.restore.mockRejectedValue(new Error('agent_session_checkpoint_merge-conflicts'))
    const view = renderHook(() => useNativeChatRewind(input(checkpoints)))
    await act(() => view.result.current.request('user', answer(true, [])))
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0]?.[0]).toContain('The chat was rewound, but')
    expect(toast.error.mock.calls[0]?.[0]).toContain('unresolved merge conflicts')
    expect(toast.success).not.toHaveBeenCalled()
  })
})
