import type React from 'react'
import { useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type DefaultEditorSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function DefaultEditorSetting({
  settings,
  updateSettings
}: DefaultEditorSettingProps): React.JSX.Element {
  const mode = settings.defaultEditorMode ?? 'builtin'
  const persistedCommand = settings.defaultEditorCustomCommand ?? ''
  const [commandDraft, setCommandDraft] = useState(persistedCommand)
  const inputFocusedRef = useRef(false)

  // Why: Settings can change outside this pane (e.g. profile sync); reconcile
  // the draft before paint so the input never lags the persisted value. Never
  // clobber in-flight typing.
  if (!inputFocusedRef.current && commandDraft !== persistedCommand) {
    setCommandDraft(persistedCommand)
  }

  const commitCommand = (): void => {
    const trimmed = commandDraft.trim()
    updateSettings({ defaultEditorCustomCommand: trimmed })
    setCommandDraft(trimmed)
  }

  return (
    <SearchableSetting
      title={translate('auto.components.settings.DefaultEditorSetting.title', 'Default Editor')}
      description={translate(
        'auto.components.settings.DefaultEditorSetting.description',
        'Which editor opens files when you open them from the file tree, search, terminal links, or quick open.'
      )}
      keywords={['editor', 'default', 'external', 'terminal', 'helix', 'vim', 'code', 'command']}
      className="flex items-start justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {translate('auto.components.settings.DefaultEditorSetting.title', 'Default Editor')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.DefaultEditorSetting.description',
            'Which editor opens files when you open them from the file tree, search, terminal links, or quick open.'
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <Select
          value={mode}
          onValueChange={(value) =>
            updateSettings({ defaultEditorMode: value as GlobalSettings['defaultEditorMode'] })
          }
        >
          <SelectTrigger
            className="h-7 w-44 text-xs"
            aria-label={translate(
              'auto.components.settings.DefaultEditorSetting.title',
              'Default Editor'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="builtin" className="text-xs">
              {translate('auto.components.settings.DefaultEditorSetting.builtin', 'Orca built-in')}
            </SelectItem>
            <SelectItem value="system" className="text-xs">
              {translate('auto.components.settings.DefaultEditorSetting.system', 'System default')}
            </SelectItem>
            <SelectItem value="custom" className="text-xs">
              {translate('auto.components.settings.DefaultEditorSetting.custom', 'Custom command')}
            </SelectItem>
          </SelectContent>
        </Select>
        {mode === 'custom' ? (
          <div className="flex w-64 flex-col items-end gap-1">
            <Input
              value={commandDraft}
              placeholder={translate(
                'auto.components.settings.DefaultEditorSetting.commandPlaceholder',
                'helix, vim, code -r, …'
              )}
              onChange={(e) => setCommandDraft(e.target.value)}
              onFocus={() => {
                inputFocusedRef.current = true
              }}
              onBlur={() => {
                inputFocusedRef.current = false
                commitCommand()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitCommand()
                }
              }}
              className="h-7 w-full text-xs"
            />
            <p className="text-right text-[11px] leading-snug text-muted-foreground">
              {translate(
                'auto.components.settings.DefaultEditorSetting.commandHint',
                'Runs in a new terminal tab with the file path appended.'
              )}
            </p>
          </div>
        ) : null}
      </div>
    </SearchableSetting>
  )
}
