import { Check, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { SparsePreset } from '../../../../shared/worktree/create-types'

type SparsePresetChooserProps = {
  presets: SparsePreset[]
  selectedPresetId: string | null
  onSelect: (preset: SparsePreset) => void
  onSelectFull: () => void
  onEdit: (preset: SparsePreset) => void
  onNew: () => void
}

export function SparsePresetChooser({
  presets,
  selectedPresetId,
  onSelect,
  onSelectFull,
  onEdit,
  onNew
}: SparsePresetChooserProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Command
      defaultValue={selectedPresetId ? `preset:${selectedPresetId}` : 'full'}
      className="max-h-[min(var(--radix-popover-content-available-height),24rem)]"
    >
      <CommandInput
        placeholder={t('sparsePreset.search', 'Find a preset…')}
        aria-label={t('sparsePreset.search', 'Find a preset…')}
      />
      <CommandList className="min-h-0 flex-1">
        <CommandEmpty>{t('sparsePreset.noMatches', 'No matching presets.')}</CommandEmpty>
        <CommandItem
          value="full"
          keywords={[t('sparsePreset.fullCheckout', 'Full checkout')]}
          onSelect={onSelectFull}
          selection="palette"
        >
          <Check className={cn('size-4 shrink-0', selectedPresetId && 'opacity-0')} />
          <div className="min-w-0">
            <div>{t('sparsePreset.fullCheckout', 'Full checkout')}</div>
            <div className="text-xs text-muted-foreground">
              {t('sparsePreset.allFiles', 'All repository files')}
            </div>
          </div>
        </CommandItem>
        {presets.map((preset) => (
          <CommandItem
            key={preset.id}
            value={`preset:${preset.id}`}
            keywords={[preset.name, ...preset.directories]}
            onSelect={() => onSelect(preset)}
            selection="palette"
          >
            <Check
              className={cn('size-4 shrink-0', selectedPresetId !== preset.id && 'opacity-0')}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate">{preset.name}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {preset.directories.join(', ')}
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('sparsePreset.editNamed', 'Edit {{name}}', {
                    name: preset.name
                  })}
                  onClick={(event) => {
                    event.stopPropagation()
                    onEdit(preset)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation()
                    }
                  }}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('sparsePreset.editNamed', 'Edit {{name}}', { name: preset.name })}
              </TooltipContent>
            </Tooltip>
          </CommandItem>
        ))}
      </CommandList>
      <div className="shrink-0 border-t border-border p-1">
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          onClick={onNew}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
            }
          }}
        >
          <Plus />
          {t('auto.components.sparse.SparseCheckoutPresetSelect.c4ac80151d', 'New preset')}
        </Button>
      </div>
    </Command>
  )
}
