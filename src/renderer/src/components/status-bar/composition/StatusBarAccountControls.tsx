import React from 'react'

export function AccountRuntimeToggle<TGroup extends { key: string; label: string }>({
  groups,
  value,
  onChange,
  ariaLabel
}: {
  groups: TGroup[]
  value: string
  onChange: (group: TGroup) => void
  ariaLabel: string
}): React.JSX.Element | null {
  if (groups.length <= 1) {
    return null
  }

  return (
    <div className="px-2 pt-2">
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="inline-flex w-full items-center rounded-md border border-border bg-background/50 p-0.5"
      >
        {groups.map((group) => {
          const active = group.key === value
          return (
            <button
              key={group.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(group)}
              className={`min-w-0 flex-1 rounded-sm px-2 py-1 text-center text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="block truncate">{group.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
