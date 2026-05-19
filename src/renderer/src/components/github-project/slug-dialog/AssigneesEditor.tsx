import React, { useMemo, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import { useAppStore } from '@/store'

export function AssigneesEditor({
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
  const settings = useAppStore((s) => s.settings)
  // Why: stabilize the assignee seed identity. `selected` is a fresh array on
  // every parent render — depending on it directly would refire the IPC for
  // every unrelated re-render while the popover is open.
  const seedKey = useMemo(() => selected.slice().sort().join(','), [selected])
  const metadata = useRepoAssigneesBySlug(
    open ? owner : null,
    open ? repo : null,
    seedKey ? seedKey.split(',') : [],
    settings
  )
  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="rounded-md border border-border/50 bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted/30"
        >
          Assignees: {selected.length === 0 ? 'none' : selected.join(', ')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {metadata.loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
        ) : (
          metadata.data.map((u) => {
            const isOn = selected.includes(u.login)
            return (
              <button
                key={u.login}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                onClick={() => {
                  if (isOn) {
                    void onChange([], [u.login])
                  } else {
                    void onChange([u.login], [])
                  }
                }}
              >
                <span
                  className={cn(
                    'inline-block size-2 rounded-full',
                    isOn ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                />
                {u.avatarUrl ? (
                  <img src={u.avatarUrl} alt="" className="size-4 rounded-full" />
                ) : null}
                {u.login}
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}
