import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type TerminalCloseCallbacks = {
  onClosed?: (archiveId?: string) => void
  onCancel?: () => void
  onError?: (error: Error) => void
}

export function awaitTerminalTabClose<TOptions extends TerminalCloseCallbacks>(
  close: (tabId: string, options?: TOptions) => void,
  tabId: string,
  options?: TOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    close(tabId, {
      ...options,
      onClosed: (archiveId) => {
        options?.onClosed?.(archiveId)
        resolve()
      },
      onCancel: () => {
        options?.onCancel?.()
        reject(new Error('terminal_tab_close_cancelled'))
      },
      onError: (error) => {
        if (options?.onError) {
          options.onError(error)
        } else {
          toast.error(
            translate(
              'auto.components.terminal.terminal.tab.close.completion.cbbc80b16f',
              'Terminal was not closed'
            ),
            {
              description: error.message,
              action: {
                label: translate(
                  'auto.components.terminal.terminal.tab.close.completion.814c051db5',
                  'Retry'
                ),
                onClick: () => void awaitTerminalTabClose(close, tabId, options).catch(() => {})
              }
            }
          )
        }
        reject(error)
      }
    } as TOptions)
  })
}
