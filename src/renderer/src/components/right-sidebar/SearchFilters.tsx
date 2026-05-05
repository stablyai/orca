import React from 'react'

type SearchFiltersProps = {
  includePattern: string
  excludePattern: string
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
  includeInputRef?: React.RefObject<HTMLInputElement | null>
  excludeInputRef?: React.RefObject<HTMLInputElement | null>
}

export function SearchFilters({
  includePattern,
  excludePattern,
  onIncludeChange,
  onExcludeChange,
  includeInputRef,
  excludeInputRef
}: SearchFiltersProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Files To Include
        </span>
        <input
          ref={includeInputRef}
          type="text"
          className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground/50"
          placeholder="files to include (e.g. *.ts, src/**)"
          value={includePattern}
          onChange={(e) => onIncludeChange(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Files To Exclude
        </span>
        <input
          ref={excludeInputRef}
          type="text"
          className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground/50"
          placeholder="files to exclude (e.g. *.min.js, dist/**)"
          value={excludePattern}
          onChange={(e) => onExcludeChange(e.target.value)}
          spellCheck={false}
        />
      </label>
    </div>
  )
}
