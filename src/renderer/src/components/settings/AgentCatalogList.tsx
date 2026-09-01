import { useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'
import {
  agentCatalogRowKey,
  filterAgentCatalogRows,
  type AgentCatalogRow
} from './agent-catalog-rows'
import {
  AgentCatalogRowView,
  type AgentCatalogActionAvailability,
  type AgentCatalogRowCallbacks
} from './AgentCatalogRowView'

export type AgentCatalogListProps = {
  rows: readonly AgentCatalogRow[]
  /** Paired web is view-only: row controls disable, but search stays usable. */
  readOnly?: boolean
  availability?: AgentCatalogActionAvailability
} & AgentCatalogRowCallbacks

// Bounded overscan keeps the mounted DOM small even at 1,000 rows (plan §978:
// at most 60 mounted rows). The constrained container plus this overscan keeps
// visible + 2×overscan well under that cap.
const ROW_ESTIMATE_PX = 52
const ROW_OVERSCAN = 8

export function AgentCatalogList({
  rows,
  readOnly,
  availability,
  ...callbacks
}: AgentCatalogListProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Filter once per keystroke against the per-revision summaries, not per row.
  const filtered = useMemo(() => filterAgentCatalogRows(rows, query), [rows, query])
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
    getItemKey: (index) => agentCatalogRowKey(filtered[index])
  })

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate(
            'auto.components.settings.AgentCatalogList.searchPlaceholder',
            'Search agents by name, harness, or command…'
          )}
          className="h-9 pl-8"
          aria-label={translate(
            'auto.components.settings.AgentCatalogList.searchLabel',
            'Search agents'
          )}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/50 px-3 py-6 text-center text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.AgentCatalogList.noMatch',
            'No agents match your search.'
          )}
        </p>
      ) : (
        // Why: the read-only fieldset covers only the rows, never the search
        // input above, so a paired client can still filter the catalog.
        <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
          <div ref={scrollRef} className="max-h-[28rem] scrollbar-sleek overflow-y-auto">
            <div
              role="list"
              aria-label={translate(
                'auto.components.settings.AgentCatalogList.listLabel',
                'Agents'
              )}
              style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const row = filtered[item.index]
                return (
                  <div
                    key={item.key}
                    role="listitem"
                    // Windowing mounts only a slice, so give assistive tech the true
                    // total and this row's position — otherwise it announces "of 60".
                    aria-setsize={filtered.length}
                    aria-posinset={item.index + 1}
                    data-index={item.index}
                    data-agent-catalog-row={agentCatalogRowKey(row)}
                    ref={virtualizer.measureElement}
                    className="border-b border-border/40 last:border-b-0"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`
                    }}
                  >
                    <AgentCatalogRowView row={row} availability={availability} {...callbacks} />
                  </div>
                )
              })}
            </div>
          </div>
        </fieldset>
      )}
    </div>
  )
}
