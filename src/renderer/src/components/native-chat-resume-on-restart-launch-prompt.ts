import { LOCAL_RESTART_MACHINE } from './native-chat-restart-machines'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'

/**
 * The one way the resume dialog opens BY ITSELF: this computer's own launch found the user's chats
 * to resume. Every other opening follows a click (status bar, toast).
 */
export function requestLaunchResumePrompt(): void {
  requestNativeChatResumeOnRestartDialog(LOCAL_RESTART_MACHINE)
}
