import type { Dispatch, SetStateAction } from 'react'
import { Plus, Search } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'
import { QuickCommandsScopeFilter } from './QuickCommandsScopeFilter'

type QuickCommandsToolbarProps = {
  query: string
  setQuery: (query: string) => void
  hostOptions: readonly { id: ExecutionHostId; label: string }[]
  showHostSelect: boolean
  selectedHostId: ExecutionHostId
  onHostChange: (hostId: ExecutionHostId) => void
  canAdd: boolean
  onAdd: () => void
  repos: readonly Repo[]
  effectiveSelection: ReadonlySet<string>
  showAll: boolean
  scopePopoverOpen: boolean
  setScopePopoverOpen: Dispatch<SetStateAction<boolean>>
  handleSelectAll: () => void
  toggleScope: (key: string) => void
}

export function QuickCommandsToolbar({
  query,
  setQuery,
  hostOptions,
  showHostSelect,
  selectedHostId,
  onHostChange,
  canAdd,
  onAdd,
  repos,
  effectiveSelection,
  showAll,
  scopePopoverOpen,
  setScopePopoverOpen,
  handleSelectAll,
  toggleScope
}: QuickCommandsToolbarProps): React.JSX.Element {
  const searchLabel = translate(
    'auto.components.settings.QuickCommandsToolbar.searchLabel',
    'Search commands'
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-52 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
          className="h-8 pl-8 text-xs"
        />
      </div>

      <QuickCommandsScopeFilter
        repos={repos}
        effectiveSelection={effectiveSelection}
        showAll={showAll}
        scopePopoverOpen={scopePopoverOpen}
        setScopePopoverOpen={setScopePopoverOpen}
        handleSelectAll={handleSelectAll}
        toggleScope={toggleScope}
      />

      {showHostSelect ? (
        <Select
          value={selectedHostId}
          onValueChange={(value) => onHostChange(value as ExecutionHostId)}
        >
          <SelectTrigger
            id="quick-command-storage-host"
            size="sm"
            aria-label={translate(
              'auto.components.settings.QuickCommandsPane.89f7e57fcc',
              'Saved on'
            )}
            className="text-xs"
          >
            <span className="text-muted-foreground">
              {translate('auto.components.settings.QuickCommandsPane.89f7e57fcc', 'Saved on')}
            </span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {hostOptions.map((host) => (
              <SelectItem key={host.id} value={host.id}>
                {host.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canAdd}
        onClick={onAdd}
        className="ml-auto"
      >
        <Plus />
        {translate('auto.components.settings.QuickCommandsPane.5aacc8f7dc', 'Add Command')}
      </Button>
    </div>
  )
}
