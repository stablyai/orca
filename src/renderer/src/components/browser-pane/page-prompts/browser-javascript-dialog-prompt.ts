import type { BrowserPagePromptHandler } from './browser-page-prompts'
import { translate } from '@/i18n/i18n'

export const javaScriptDialogPrompt: BrowserPagePromptHandler<'javascript-dialog'> = {
  ask: async (confirm, { type, message, defaultPromptText, origin }, signal) => {
    let promptText = ''
    const accept = await confirm({
      signal,
      title: origin
        ? translate('auto.components.browserPane.javaScriptDialog.title', '{{origin}} says', {
            origin
          })
        : translate(
            'auto.components.browserPane.javaScriptDialog.anonymousTitle',
            'This page says'
          ),
      description: message,
      // Page text has no length limit; keep the buttons on screen.
      descriptionClassName: 'max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words',
      acknowledgeOnly: type === 'alert',
      // Enter accepts, as in Chrome; a prompt keeps focus in its answer field.
      initialFocus: type === 'prompt' ? undefined : 'confirm',
      // A held Enter on the page's own button must not also answer the dialog it opened.
      ignoresOpeningGesture: true,
      confirmLabel: translate('auto.components.browserPane.javaScriptDialog.confirm', 'OK'),
      cancelLabel: translate('auto.components.browserPane.javaScriptDialog.cancel', 'Cancel'),
      fields:
        type === 'prompt'
          ? {
              inputs: [
                {
                  id: 'promptText',
                  label: translate('auto.components.browserPane.javaScriptDialog.answer', 'Answer'),
                  defaultValue: defaultPromptText
                }
              ],
              onConfirmed: (values) => {
                promptText = values.promptText ?? ''
              }
            }
          : undefined
    })
    // Every close is an answer the page waits for; null would also quiet the page's other prompts.
    return { accept, promptText }
  }
}
