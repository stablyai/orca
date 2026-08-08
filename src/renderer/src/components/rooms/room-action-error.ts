import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

export function showRoomActionError(error: unknown): void {
  toast.error(extractIpcErrorMessage(error, 'Room action failed.'))
}
