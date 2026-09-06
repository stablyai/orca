import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomData } from './use-room-data'
import { roomComposerRunMode } from './room-composer-run-mode'
import { showRoomActionError } from './room-action-error'

export function useRoomComposerWorkControl(input: {
  data: RoomData
  hasDraft: boolean
  sending: boolean
  sendDisabled: boolean
  send: () => Promise<void>
}) {
  const [action, setAction] = useState<'stop' | 'resume' | null>(null)
  const mode = roomComposerRunMode(input.data.snapshot?.workState, input.hasDraft)
  const run = async (): Promise<void> => {
    if (!input.data.roomId || action) {
      return
    }
    if (mode === 'send') {
      return input.send()
    }
    setAction(mode)
    try {
      await roomRpc(input.data.target, `rooms.work.${mode}`, { roomId: input.data.roomId })
    } catch (error) {
      showRoomActionError(error)
    } finally {
      setAction(null)
    }
  }
  return {
    mode,
    run,
    loading: action !== null,
    disabled: action !== null || input.sending || (mode === 'send' && input.sendDisabled),
    label:
      mode === 'stop'
        ? translate('rooms.composer.stop', 'Stop room')
        : mode === 'resume'
          ? translate('rooms.composer.resume', 'Resume room')
          : translate('rooms.common.send', 'Send')
  }
}
