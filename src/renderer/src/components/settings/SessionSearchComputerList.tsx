import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const VISIBLE_COMPUTER_LIMIT = 6

export type SessionSearchServerRowEntry = { id: string; node: React.ReactNode }

export function SessionSearchComputerList({
  local,
  servers
}: {
  local: React.ReactNode
  servers: readonly SessionSearchServerRowEntry[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visibleServerCount = VISIBLE_COMPUTER_LIMIT - 1
  const hiddenCount = Math.max(0, servers.length - visibleServerCount)
  const shownServers = expanded ? servers : servers.slice(0, visibleServerCount)
  // Show paired subheads only when servers exist; one local row needs no heading.
  const showSubheads = servers.length > 0
  return (
    <div>
      {showSubheads ? (
        <p className="pt-4 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('sessionHistory.settings.thisComputer', 'This computer')}
        </p>
      ) : null}
      {local}
      {showSubheads ? (
        <p className="pt-4 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('sessionHistory.settings.remoteServers', 'Orca remote servers')}
        </p>
      ) : null}
      {shownServers.map((server) => (
        <div key={server.id}>{server.node}</div>
      ))}
      {hiddenCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <>
              {translate('sessionHistory.settings.showFewer', 'Show fewer')}
              <ChevronUp />
            </>
          ) : (
            <>
              {translate('sessionHistory.settings.showMore', 'Show {{count}} more', {
                count: hiddenCount
              })}
              <ChevronDown />
            </>
          )}
        </Button>
      ) : null}
    </div>
  )
}
