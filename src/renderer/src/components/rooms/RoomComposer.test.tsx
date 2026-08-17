// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import type { RoomParticipant } from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'
import type * as RoomComposerSuggestionsModule from './RoomComposerSuggestions'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-rooms-client', () => ({ roomRpc: mocks.rpc }))
vi.mock('./room-action-error', () => ({ showRoomActionError: mocks.report }))
vi.mock('./RoomComposerActions', () => ({
  RoomComposerActions: ({
    run
  }: {
    run: { label: string; disabled: boolean; invoke: () => void }
  }) => (
    <button type="button" disabled={run.disabled} onClick={run.invoke}>
      {run.label}
    </button>
  )
}))
vi.mock('./RoomComposerSuggestions', async (importOriginal) => ({
  ...(await importOriginal<typeof RoomComposerSuggestionsModule>()),
  RoomComposerSuggestions: () => null
}))

import { RoomComposer } from './RoomComposer'

const participant = (id: string): RoomParticipant => ({
  id,
  roomId: 'room',
  identity: id,
  displayName: id.toUpperCase(),
  actorKind: 'agent',
  agent: 'codex',
  roleId: null,
  worktreeId: null,
  paneKey: null,
  terminalHandle: null,
  providerSession: null,
  processIncarnation: null,
  terminalSurfaceVisible: false,
  participation: 'active',
  state: 'online',
  context: EMPTY_AGENT_SESSION_CONTEXT,
  lastSeenAt: null,
  createdAt: 0,
  updatedAt: 0
})

const roomData = (deliveryQueueVersion?: 1): RoomData =>
  ({
    target: { kind: 'local' },
    roomId: 'room',
    snapshot: {
      deliveryQueueVersion,
      workState: 'idle',
      participants: [participant('alpha'), participant('beta')]
    },
    messages: [],
    deliveries: {}
  }) as RoomData

describe('RoomComposer queue targets', () => {
  beforeEach(() => mocks.rpc.mockResolvedValue({ message: {} }))
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('makes an @ mention select the same queue target and resets to All', async () => {
    render(<RoomComposer data={roomData(1)} />)

    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@beta', selectionStart: 5 } })
    fireEvent.keyDown(textarea, { key: ' ' })
    expect(screen.getByRole('button', { name: 'BETA' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        { kind: 'local' },
        'rooms.messages.send',
        expect.objectContaining({
          roomId: 'room',
          mentions: ['beta'],
          targetParticipantIds: ['beta']
        })
      )
    )
    const params = mocks.rpc.mock.calls.find(([, method]) => method === 'rooms.messages.send')![2]
    expect(params).not.toHaveProperty('replyToId')
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('hides targets and omits the field without queue capability', async () => {
    render(<RoomComposer data={roomData()} />)

    expect(screen.queryByRole('button', { name: 'All' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        { kind: 'local' },
        'rooms.messages.send',
        expect.any(Object)
      )
    )
    const params = mocks.rpc.mock.calls.find(([, method]) => method === 'rooms.messages.send')![2]
    expect(params).not.toHaveProperty('targetParticipantIds')
  })

  it('accepts an empty Resume result when clearing a persisted room pause', async () => {
    const data = roomData(1)
    data.snapshot!.workState = 'stopped'
    mocks.rpc.mockResolvedValueOnce({ resumed: 0 })
    render(<RoomComposer data={data} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/continue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'rooms.work.resume', {
        roomId: 'room'
      })
    )
    expect(mocks.report).not.toHaveBeenCalled()
  })
})
