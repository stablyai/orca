import React from 'react'

type SearchFiltersProps = {
  includePattern: string
  excludePattern: string
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
}

export function SearchFilters({
  includePattern,
  excludePattern,
  onIncludeChange,
  onExcludeChange
}: SearchFiltersProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <input
        type="text"
        className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground/50"
        placeholder="files to include (e.g. *.ts, src/**)"
        value={includePattern}
        onChange={(e) => onIncludeChange(e.target.value)}
        spellCheck={false}
      />
      <input
        type="text"
        className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground/50"
        placeholder="files to exclude (e.g. *.min.js, dist/**)"
        value={excludePattern}
        onChange={(e) => onExcludeChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  )
}
