import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** Local computer plus five servers. Past that the list stops being a list and becomes a wall. */
const VISIBLE_COMPUTER_LIMIT = 6

export type SessionSearchServerRowEntry = { id: string; node: React.ReactNode }

/**
 * Presentation only: the caller has already decided which servers exist and in
 * what order, so the list owns nothing but the two subheads and the fold.
 */
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
  // One row needs no heading to tell it apart from the rest; the pair of subheads appears together or not at all.
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
