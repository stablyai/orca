import { useRef, useState } from 'react'
import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseTheme } from '../../../../shared/custom-ui-themes'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Trash2 } from 'lucide-react'
import { SettingsRow } from './SettingsFormControls'
import { AppearanceAdvancedDisclosure } from './AppearanceAdvancedDisclosure'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type CustomUiThemeManagerProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function CustomUiThemeManager({
  settings,
  updateSettings
}: CustomUiThemeManagerProps): React.JSX.Element {
  const nameRef = useRef<HTMLInputElement>(null)
  const cssRef = useRef<HTMLTextAreaElement>(null)
  const [importError, setImportError] = useState<string | null>(null)

  return (
    <div className="space-y-3 py-2">
      {/* Active Theme Selector */}
      <SettingsRow
        label={translate('settings.appearance.customUiTheme.activeLabel', 'Active Theme')}
        control={
          <Select
            value={settings.activeUiTheme || 'default'}
            onValueChange={(val) => updateSettings({ activeUiTheme: val })}
          >
            <SelectTrigger size="sm" className="min-w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                {translate(
                  'settings.appearance.customUiTheme.defaultTheme',
                  'Default'
                )}
              </SelectItem>
              {(settings.customUiThemes || []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/* Collapsible custom themes list and import form */}
      <AppearanceAdvancedDisclosure
        label={translate(
          'settings.appearance.customUiTheme.customThemesList',
          'Custom Themes'
        )}
        showTopBorder={false}
        className="mt-1 pt-0"
        contentClassName="space-y-3 pt-2"
      >
        {/* Dedicated Custom Themes Management List */}
        {settings.customUiThemes && settings.customUiThemes.length > 0 ? (
          <div className="space-y-1 max-h-[150px] overflow-y-auto pr-1">
            {settings.customUiThemes.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between text-xs py-1 px-2 rounded-md hover:bg-accent/40"
              >
                <span className="truncate pr-2">{t.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    const remaining = (settings.customUiThemes || []).filter(
                      (theme) => theme.id !== t.id
                    )
                    const activeIsDeleted = settings.activeUiTheme === t.id
                    updateSettings({
                      activeUiTheme: activeIsDeleted ? 'default' : settings.activeUiTheme,
                      customUiThemes: remaining
                    })
                  }}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  title={translate(
                    'settings.appearance.customUiTheme.deleteTheme',
                    'Delete theme'
                  )}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Import New Theme Form */}
        <div
          className={cn(
            'pt-3 space-y-2',
            settings.customUiThemes &&
              settings.customUiThemes.length > 0 &&
              'border-t border-border/40'
          )}
        >
          <h4 className="text-xs font-semibold">
            {translate(
              'settings.appearance.customUiTheme.importTheme',
              'Import Theme'
            )}
          </h4>
          <div className="flex gap-2">
            <Input
              ref={nameRef}
              type="text"
              placeholder={translate(
                'settings.appearance.customUiTheme.themeNamePlaceholder',
                'Theme Name (e.g. Claude)'
              )}
              className="flex-1 h-8 text-xs bg-transparent dark:bg-input/30"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const fallbackName = translate(
                  'settings.appearance.customUiTheme.fallbackThemeName',
                  'Custom Theme'
                )
                const name = nameRef.current?.value?.trim() || fallbackName
                const content = cssRef.current?.value?.trim() || ''

                if (!content) {
                  return
                }

                setImportError(null)
                const importedThemes = parseTheme(name, content)

                if (importedThemes.length === 0) {
                  setImportError(
                    translate(
                      'settings.appearance.customUiTheme.importErrorDescription',
                      'Could not parse any variables. Make sure it has :root or .dark blocks, or matches Shadcn theme JSON.'
                    )
                  )
                  return
                }

                const prevThemes = settings.customUiThemes || []
                const filtered = prevThemes.filter(
                  (pt) => !importedThemes.some((it) => it.id === pt.id)
                )
                const nextThemes = [...filtered, ...importedThemes]

                const isCurrentlyDark =
                  settings.theme === 'dark' ||
                  (settings.theme === 'system' &&
                    window.matchMedia('(prefers-color-scheme: dark)').matches)
                const matchingFlavor = importedThemes.find((t) =>
                  isCurrentlyDark ? t.mode === 'dark' : t.mode === 'light'
                )
                const toSelect = matchingFlavor || importedThemes[0]

                updateSettings({
                  customUiThemes: nextThemes,
                  activeUiTheme: toSelect.id
                })

                if (nameRef.current) {
                  nameRef.current.value = ''
                }
                if (cssRef.current) {
                  cssRef.current.value = ''
                }
              }}
            >
              {translate(
                'settings.appearance.customUiTheme.importButton',
                'Import'
              )}
            </Button>
          </div>
          {importError ? <p className="text-xs text-destructive">{importError}</p> : null}
          <Textarea
            ref={cssRef}
            placeholder={translate(
              'settings.appearance.customUiTheme.textareaPlaceholder',
              'Paste CSS theme code (Tweakcn output) or Shadcn theme JSON...'
            )}
            className="h-16 font-mono text-xs resize-none"
            onChange={() => setImportError(null)}
          />
        </div>
      </AppearanceAdvancedDisclosure>
    </div>
  )
}
