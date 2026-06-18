import type React from 'react'

export type AddRepoCreateKind = 'git' | 'folder'

type AddRepoCreateKindCardProps = {
  kind: AddRepoCreateKind
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onArrowNav: () => void
  icon: React.ReactNode
  title: string
  caption: string
}

export function AddRepoCreateKindCard({
  kind,
  selected,
  disabled,
  onSelect,
  onArrowNav,
  icon,
  title,
  caption
}: AddRepoCreateKindCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Why: WAI-ARIA radiogroup spec expects all four arrow keys to move
        // selection, even if this specific layout is horizontal today.
        if (
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown'
        ) {
          e.preventDefault()
          onArrowNav()
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onSelect()
        }
      }}
      disabled={disabled}
      data-kind={kind}
      className={`group relative flex cursor-pointer items-center gap-3 rounded-md border px-3.5 py-3.5 text-left text-xs transition-colors outline-none ${
        selected ? 'border-foreground/30 bg-accent' : 'border-border hover:bg-accent/50'
      } focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <span
        className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
          selected
            ? 'border-foreground/20 bg-background/60 text-foreground'
            : 'border-border/70 bg-background/30 text-muted-foreground group-hover:text-foreground'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {caption}
        </span>
      </span>
    </button>
  )
}
