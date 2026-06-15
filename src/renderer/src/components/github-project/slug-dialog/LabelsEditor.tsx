import React, { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useRepoLabelsBySlug } from '@/hooks/useGitHubSlugMetadata'
import type { GlobalSettings } from '../../../../../shared/types'
import { translate } from '@/i18n/i18n'

export function LabelsEditor({
  owner,
  repo,
  selected,
  disabled,
  sourceSettings,
  onChange
}: {
  owner: string
  repo: string
  selected: string[]
  disabled?: boolean
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onChange: (add: string[], remove: string[]) => void | Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const metadata = useRepoLabelsBySlug(open ? owner : null, open ? repo : null, sourceSettings)
  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="rounded-md border border-border/50 bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted/30"
        >
          {translate(
            'auto.components.github.project.slug.dialog.LabelsEditor.a7b182fcda',
            'Labels:'
          )}
          {selected.length === 0
            ? translate(
                'auto.components.github.project.slug.dialog.LabelsEditor.1a5366b5be',
                'none'
              )
            : selected.join(', ')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {metadata.loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.slug.dialog.LabelsEditor.34dd57d6c8',
              'Loading…'
            )}
          </div>
        ) : (
          metadata.data.map((name) => {
            const isOn = selected.includes(name)
            return (
              <button
                key={name}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                onClick={() => {
                  if (isOn) {
                    void onChange([], [name])
                  } else {
                    void onChange([name], [])
                  }
                }}
              >
                <span
                  className={cn(
                    'inline-block size-2 rounded-full',
                    isOn ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                />
                {name}
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}
