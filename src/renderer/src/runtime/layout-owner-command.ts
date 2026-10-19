import { useAppStore } from '@/store'
import {
  sendLayoutApply,
  type LayoutApplyHandlers,
  type WindowLayoutCommand
} from './layout-apply-send'

/** `sendLayoutApply` against the current store. */
export function sendLayoutCommandToOwner(
  worktreeId: string,
  command: WindowLayoutCommand,
  handlers: LayoutApplyHandlers
): boolean {
  return sendLayoutApply(useAppStore.getState(), worktreeId, command, handlers)
}
