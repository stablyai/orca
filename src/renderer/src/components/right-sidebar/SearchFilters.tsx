import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

type SearchFiltersProps = {
  showFilters: boolean
  includePattern: string
  excludePattern: string
  onToggleFilters: () => void
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
}

export function SearchFilters({
  showFilters,
  includePattern,
  excludePattern,
  onToggleFilters,
  onIncludeChange,
  onExcludeChange
}: SearchFiltersProps): React.JSX.Element {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="h-auto justify-start gap-1 self-start px-0 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={onToggleFilters}
      >
        {showFilters ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>files to include/exclude</span>
      </Button>

      {showFilters && (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground"
            placeholder="files to include (e.g. *.ts, src/**)"
            value={includePattern}
            onChange={(e) => onIncludeChange(e.target.value)}
            spellCheck={false}
          />
          <input
            type="text"
            className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground"
            placeholder="files to exclude (e.g. *.min.js, dist/**)"
            value={excludePattern}
            onChange={(e) => onExcludeChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
    </>
  )
}
