import { useEffect, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { AgentTerminalPreview } from '../dashboard-popout/AgentTerminalPreview'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../shared/terminal-scrollback-policy'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'

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
  // Why: the companion is the tab's whole view, so it keeps as much history as the pane does.
  const scrollbackRows = useAppStore((state) =>
    normalizeDesktopTerminalScrollbackRows(state.settings?.terminalScrollbackRows)
  )
  // Why: the pane's input facts (ConPTY, agent paste rules) live in the main renderer; undefined until read.
  const [terminalInput, setTerminalInput] = useState<DashboardCardTerminalInput | null>()
  useEffect(() => {
    // Why: a pushed change is newer than the stored facts; undefined means the push is still coming.
    let pushed = false
    const unsubscribe = window.api.detachedTerminal.onTerminalInput((next) => {
      pushed = true
      setTerminalInput(next)
    })
    void window.api.detachedTerminal.getTerminalInput(tabId).then(
      (initial) => !pushed && initial !== undefined && setTerminalInput(initial),
      () => !pushed && setTerminalInput(null)
    )
    return unsubscribe
  }, [tabId])
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
      {/* Mount once the facts are known: xterm reads its ConPTY and kitty options only at mount. */}
      {terminalInput !== undefined && (
        <AgentTerminalPreview
          ptyId={ptyId}
          terminalInput={terminalInput}
          scrollbackRows={scrollbackRows}
          className="h-full min-h-0 flex-1"
        />
      )}
    </main>
  )
}
