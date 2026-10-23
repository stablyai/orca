import { ArrowDownToLine } from 'lucide-react'
import { AgentTerminalPreview } from '../dashboard-popout/AgentTerminalPreview'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export type DetachedTerminalWindowParams = {
  tabId: string
  ptyId: string
  title: string
}

export function readDetachedTerminalWindowParams(
  search: string
): DetachedTerminalWindowParams | null {
  const params = new URLSearchParams(search)
  const tabId = params.get('tabId')
  const ptyId = params.get('ptyId')
  const title = params.get('title')
  if (params.get('surface') !== 'terminal' || !tabId || !ptyId || !title) {
    return null
  }
  return { tabId, ptyId, title }
}

export function DetachedTerminalWindow({
  tabId,
  ptyId,
  title
}: DetachedTerminalWindowParams): React.JSX.Element {
  return (
    <main className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => void window.api.detachedTerminal.returnToMain(tabId)}
        >
          <ArrowDownToLine />
          {translate(
            'components.detachedTerminal.moveBackToMainWindow',
            'Move Back to Main Window'
          )}
        </Button>
      </header>
      <AgentTerminalPreview ptyId={ptyId} className="h-full min-h-0 flex-1" />
    </main>
  )
}
