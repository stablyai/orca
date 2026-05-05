import React, { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export function LabelsEditor({
  owner,
  repo,
  selected,
  disabled,
  onChange
}: {
  owner: string
  repo: string
  selected: string[]
  disabled?: boolean
  onChange: (add: string[], remove: string[]) => void | Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) {return}
    // Why: guard against late responses overwriting newer state when the
    // popover toggles owner/repo (or closes/reopens) while the IPC is still
    // in flight. Mirrors the requestIdRef pattern used for the details fetch.
    let cancelled = false
    setLoading(true)
    window.api.gh
      .listLabelsBySlug({ owner, repo })
      .then((res) => {
        if (cancelled) {return}
        if (res.ok) {setOptions(res.labels)}
      })
      .finally(() => {
        if (cancelled) {return}
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, owner, repo])
  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="rounded-md border border-border/50 bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted/30"
        >
          Labels: {selected.length === 0 ? 'none' : selected.join(', ')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
        ) : (
          options.map((name) => {
            const isOn = selected.includes(name)
            return (
              <button
                key={name}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                onClick={() => {
                  if (isOn) {void onChange([], [name])}
                  else {void onChange([name], [])}
                }}
              >
                <span className={cn('inline-block size-2 rounded-full', isOn ? 'bg-primary' : 'bg-muted-foreground/40')} />
                {name}
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}
