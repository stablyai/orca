// The composer's one primary button. A held queue's Resume takes Send's place only while nothing
// is typed or attached, so a typed message always offers Send.

export type NativeChatComposerPrimaryAction = 'stop' | 'resume' | 'send'

/** Present while the host holds the queue and no turn runs. */
export type NativeChatQueueResume = { resume: () => void; resuming: boolean }

export function nativeChatComposerPrimaryAction(input: {
  isWorking: boolean
  composerEmpty: boolean
  /** The host holds a card Resume would send. */
  queueHeld: boolean
}): NativeChatComposerPrimaryAction {
  if (input.isWorking) {
    return 'stop'
  }
  return input.composerEmpty && input.queueHeld ? 'resume' : 'send'
}

/** The button as rendered: its action, whether it is disabled, and Resume's handler when it is
 *  Resume. Stop's and Send's own disabled state is `sendDisabled`. */
export function nativeChatComposerPrimaryButton(input: {
  isWorking: boolean
  composerEmpty: boolean
  queueResume: NativeChatQueueResume | undefined
  /** The composer cannot send at all. */
  composerDisabled: boolean
  sendDisabled: boolean
}): { action: NativeChatComposerPrimaryAction; disabled: boolean; resume?: () => void } {
  const { queueResume } = input
  const action = nativeChatComposerPrimaryAction({
    isWorking: input.isWorking,
    composerEmpty: input.composerEmpty,
    queueHeld: queueResume !== undefined
  })
  if (action === 'resume' && queueResume) {
    const disabled = input.composerDisabled || queueResume.resuming
    return { action, disabled, resume: queueResume.resume }
  }
  return { action, disabled: input.sendDisabled }
}
