import { useEffect } from 'react'
import { ArrowLeft, Database } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ConnectionList } from './ConnectionList'
import { SchemaTree } from './SchemaTree'
import { QueryWorkspace } from './QueryWorkspace'

// Phase 2: connection list + form mount into the body slot below the header.
export default function DatabasePage(): React.JSX.Element {
  const closeDatabasePage = useAppStore((s) => s.closeDatabasePage)
  const loadDbConnections = useAppStore((s) => s.loadDbConnections)
  const subscribeDbStatusChanges = useAppStore((s) => s.subscribeDbStatusChanges)
  const activeDbConnectionId = useAppStore((s) => s.activeDbConnectionId)

  useEffect(() => {
    void loadDbConnections()
  }, [loadDbConnections])

  // Why: live status (connected/lost/error) is pushed from the main process; keep
  // the subscription for the page's lifetime so a dropped connection updates the UI.
  useEffect(() => subscribeDbStatusChanges(), [subscribeDbStatusChanges])

  useEffect(() => {
    const hasVisibleOverlay = (): boolean =>
      Array.from(
        document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')
      ).some((element) => element instanceof HTMLElement)

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      // Why: menus and dialogs own Escape before page-level navigation.
      if (hasVisibleOverlay()) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target?.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
      ) {
        return
      }
      event.preventDefault()
      closeDatabasePage()
    }

    // Why: capture keeps page-level back navigation reliable when no overlay is active.
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeDatabasePage])

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={closeDatabasePage}
          className="shrink-0 gap-1.5"
        >
          <ArrowLeft className="size-3.5" />
          {translate('auto.components.database.DatabasePage.back', 'Back')}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Database className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold">
                {translate('auto.components.database.DatabasePage.title', 'Database')}
              </h1>
              <Badge variant="secondary">
                {translate('auto.components.database.DatabasePage.beta', 'Beta')}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {translate(
                'auto.components.database.DatabasePage.subtitle',
                'Connect to Postgres and MySQL servers'
              )}
            </p>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-h-0 flex-col ${
            activeDbConnectionId ? 'w-[340px] shrink-0 border-r border-border' : 'min-w-0 flex-1'
          }`}
        >
          <ConnectionList />
        </div>
        {/* Schema browser + query workspace for the active (connected) connection. */}
        {activeDbConnectionId ? (
          <>
            <div className="flex min-h-0 w-[260px] shrink-0 flex-col border-r border-border">
              <SchemaTree key={activeDbConnectionId} connectionId={activeDbConnectionId} />
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <QueryWorkspace key={activeDbConnectionId} connectionId={activeDbConnectionId} />
            </div>
          </>
        ) : null}
      </div>
    </main>
  )
}
