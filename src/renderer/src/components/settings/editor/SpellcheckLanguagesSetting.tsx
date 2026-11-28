import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { MAX_SPELLCHECK_LANGUAGES } from '../../../../../shared/settings/spellcheck-languages'
import { Button } from '../../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { cn } from '@/lib/class-names'
import { languageDisplayName } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'

type SpellcheckLanguageOption = {
  code: string
  label: string
}

/** Languages Chromium's spellchecker should run; empty means whatever the OS picked. */
export function SpellcheckLanguagesSetting({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'spellcheckLanguages'>
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const isMac = window.api.platform?.get()?.platform === 'darwin'
  const selected = settings.spellcheckLanguages ?? []
  const [available, setAvailable] = useState<string[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (isMac) {
      // macOS uses the OS spellchecker, which detects the language itself.
      setAvailable([])
      return
    }
    let cancelled = false
    void window.api.settings
      .listSpellcheckLanguages()
      .then((languages) => {
        if (!cancelled) {
          setAvailable(languages)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [isMac])

  const options = useMemo<SpellcheckLanguageOption[]>(
    () =>
      (available ?? [])
        .map((code) => ({ code, label: languageDisplayName(code, intlLocale) }))
        .sort((a, b) => a.label.localeCompare(b.label, intlLocale)),
    [available, intlLocale]
  )
  const selectedNames = selected.map((code) => languageDisplayName(code, intlLocale)).join(', ')
  const atLimit = selected.length >= MAX_SPELLCHECK_LANGUAGES

  const toggleLanguage = (code: string): void => {
    if (selected.includes(code)) {
      void updateSettings({ spellcheckLanguages: selected.filter((entry) => entry !== code) })
      return
    }
    if (!atLimit) {
      void updateSettings({ spellcheckLanguages: [...selected, code] })
    }
  }

  const description = isMac
    ? t(
        'settings.editorSpellcheckLanguages.macDescription',
        'macOS uses the system spellchecker and picks the language automatically.'
      )
    : t(
        'settings.editorSpellcheckLanguages.description',
        'Dictionaries spellcheck uses in editors and chat. Leave empty to follow the system language.'
      )
  const title = t('settings.editorSpellcheckLanguages.title', 'Spellcheck languages')

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.spellcheckLanguages}
      title={title}
      description={description}
      keywords={[
        'spellcheck',
        'spell check',
        'spelling',
        'language',
        'dictionary',
        'dictionaries',
        'locale'
      ]}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={open}
                aria-label={title}
                disabled={isMac || available === null}
                className="min-w-52 max-w-72 justify-between"
              >
                <span className="truncate">
                  {isMac
                    ? t('settings.editorSpellcheckLanguages.systemLanguage', 'System language')
                    : selectedNames ||
                      t('settings.editorSpellcheckLanguages.systemDefault', 'System default')}
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="flex max-h-(--radix-popover-content-available-height) w-[max(var(--radix-popover-trigger-width),18rem)] flex-col"
            >
              <Command>
                <CommandInput
                  placeholder={t('settings.editorSpellcheckLanguages.search', 'Search languages…')}
                />
                <div className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => void updateSettings({ spellcheckLanguages: [] })}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                      selected.length === 0 && 'opacity-80'
                    )}
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        selected.length === 0 ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <span>
                      {t('settings.editorSpellcheckLanguages.systemDefault', 'System default')}
                    </span>
                  </button>
                </div>
                <CommandList>
                  <CommandEmpty>
                    {t(
                      'settings.editorSpellcheckLanguages.empty',
                      'No spellcheck dictionaries are available.'
                    )}
                  </CommandEmpty>
                  {options.map((option) => {
                    const isSelected = selected.includes(option.code)
                    return (
                      <CommandItem
                        key={option.code}
                        value={`${option.code} ${option.label}`}
                        disabled={!isSelected && atLimit}
                        onSelect={() => toggleLanguage(option.code)}
                      >
                        <Check
                          className={cn(
                            'size-3 text-muted-foreground',
                            isSelected ? 'opacity-70' : 'opacity-0'
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        <span className="text-[10px] text-muted-foreground">{option.code}</span>
                      </CommandItem>
                    )
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        }
      />
    </SearchableSetting>
  )
}
