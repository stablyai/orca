import type { RoomWorkState } from '../../../../shared/rooms'
import type { ComposerRunMode } from '@/components/ComposerRunButton'

export function roomComposerRunMode(
  workState: RoomWorkState | undefined,
  hasDraft: boolean
): ComposerRunMode {
  return workState === 'active' ? 'stop' : workState === 'stopped' && !hasDraft ? 'resume' : 'send'
}
