import { useState } from 'react'
import { History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { RunHistoryBrowser } from '../orchestration-history/RunHistoryBrowser'
import ActivityPrototypePage from './ActivityPrototypePage'

export default function ActivityPage(): React.JSX.Element {
  useTranslation()
  const [historyOpen, setHistoryOpen] = useState(false)
  if (historyOpen) {
    return (
      <RunHistoryBrowser
        onBack={() => setHistoryOpen(false)}
        onClose={() => setHistoryOpen(false)}
        onReveal={() => setHistoryOpen(false)}
      />
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="flex-1 text-sm font-semibold">
          {translate('dashboardPopout.title', 'Agents')}
        </h1>
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History aria-hidden="true" />
          {translate('orchestrationHistory.title', 'Run history')}
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <ActivityPrototypePage />
      </div>
    </div>
  )
}
