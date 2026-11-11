import { useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '../../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { getIntlLocale } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { cn } from '@/lib/class-names'
import { parseDevBuildStamp, type ReleaseBuild } from '../../../../../shared/release-channel'

function formatBuildLabel(build: ReleaseBuild, intlLocale: string = getIntlLocale()): string {
  if (build.name) {
    return build.name
  }
  const stamp = parseDevBuildStamp(build.version)
  if (!stamp) {
    return build.version
  }
  return `${build.version.split('-')[0]} · ${stamp.toLocaleString(intlLocale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })}`
}

export function ReleaseBuildPicker({
  builds,
  selectedTag,
  onSelect,
  disabled,
  placeholder
}: {
  builds: readonly ReleaseBuild[]
  selectedTag: string | null
  onSelect: (tag: string) => void
  disabled: boolean
  placeholder: string
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const languageRevision = useUiLanguageRevision()
  const entries = useMemo(
    () =>
      builds.map((build) => {
        const label = formatBuildLabel(build, intlLocale)
        return {
          tag: build.tag,
          label,
          searchText: `${label} ${build.version} ${build.tag}`.toLowerCase()
        }
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- labels format dates in the UI language.
    [builds, languageRevision, intlLocale]
  )
  const terms = query.trim().toLowerCase().split(/\s+/)
  const filtered = entries.filter((entry) => terms.every((term) => entry.searchText.includes(term)))
  const selected = entries.find((entry) => entry.tag === selectedTag)

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        setQuery('')
        setOpen(nextOpen)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-label={t('auto.components.settings.ReleaseBuildPicker.build', 'Build')}
          aria-expanded={open && !disabled}
          disabled={disabled}
          className="min-w-0 flex-1 justify-between"
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)]">
        <Command
          shouldFilter={false}
          defaultValue={selectedTag ?? undefined}
          label={t('auto.components.settings.ReleaseBuildPicker.searchLabel', 'Search builds')}
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t(
              'auto.components.settings.ReleaseBuildPicker.searchPlaceholder',
              'Search builds…'
            )}
          />
          <CommandList className="max-h-64">
            <CommandEmpty>
              {t('auto.components.settings.ReleaseBuildPicker.noMatches', 'No matching builds.')}
            </CommandEmpty>
            <CommandGroup>
              {filtered.map((entry) => (
                <CommandItem
                  key={entry.tag}
                  value={entry.tag}
                  selection="palette"
                  onSelect={() => {
                    onSelect(entry.tag)
                    setOpen(false)
                  }}
                >
                  <Check className={cn('size-4', entry.tag !== selectedTag && 'opacity-0')} />
                  <span className="truncate">{entry.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
