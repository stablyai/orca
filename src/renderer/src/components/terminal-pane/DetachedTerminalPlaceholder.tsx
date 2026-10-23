import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'

export function DetachedTerminalPlaceholder({ tabId }: { tabId: string }): React.JSX.Element {
  const closeDetachedTerminalWindow = useAppStore((state) => state.closeDetachedTerminalWindow)
  const focusDetachedTerminalWindow = useAppStore((state) => state.focusDetachedTerminalWindow)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <ExternalLink className="size-7 text-muted-foreground" aria-hidden />
      <p className="text-sm text-foreground">
        {translate(
          'components.terminalPane.detachedPlaceholder.message',
          'This terminal is open in another window'
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => focusDetachedTerminalWindow(tabId)}>
          {translate('components.terminalPane.detachedPlaceholder.showWindow', 'Show Window')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => closeDetachedTerminalWindow(tabId)}>
          {translate(
            'components.terminalPane.detachedPlaceholder.moveBack',
            'Move Back to Main Window'
          )}
        </Button>
      </div>
    </div>
  )
}
