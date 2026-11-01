import type React from 'react'
import { useEffect, useState } from 'react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_WINDOW_TITLE_TEMPLATE,
  formatWindowTitle,
  normalizeWindowTitleSeparator,
  normalizeWindowTitleTemplate,
  WINDOW_TITLE_SEPARATORS,
  type WindowTitleSeparatorId
} from '../../../../shared/window-title-format'
import { translate } from '@/i18n/i18n'
import { windowTitleAppName } from '@/lib/window-title-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { getWindowTitleEntries } from './appearance-window-title-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'

type AppearanceWindowTitleSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisiblePrimary?: boolean
}

const SEPARATOR_IDS = Object.keys(WINDOW_TITLE_SEPARATORS).map(normalizeWindowTitleSeparator)

function separatorLabel(id: WindowTitleSeparatorId): string {
  return `“${WINDOW_TITLE_SEPARATORS[id].trim()}”`
}

export function AppearanceWindowTitleSetting({
  settings,
  updateSettings,
  forceVisiblePrimary = false
}: AppearanceWindowTitleSettingProps): React.JSX.Element {
  const entry = getWindowTitleEntries()[0]
  const enabled = settings.windowTitleShowWorkspace === true
  const template = normalizeWindowTitleTemplate(settings.windowTitleTemplate)
  const separator = normalizeWindowTitleSeparator(settings.windowTitleSeparator)
  const [templateDraft, setTemplateDraft] = useState(template)

  useEffect(() => {
    setTemplateDraft(template)
  }, [template])

  const title = translate(
    'settings.appearance.windowTitle.title',
    'Show project, branch, and session in window title'
  )
  const templateLabel = translate('settings.appearance.windowTitle.templateLabel', 'Title format')
  const separatorTitle = translate('settings.appearance.windowTitle.separatorLabel', 'Separator')
  const preview = formatWindowTitle({
    template: templateDraft,
    separator,
    tokens: {
      app: windowTitleAppName(),
      project: 'orca',
      workspace: 'Login rework',
      branch: 'feat/login',
      tab: 'Claude Code',
      agent: 'Claude Code'
    }
  })

  const commitTemplate = (): void => {
    const next = normalizeWindowTitleTemplate(templateDraft)
    setTemplateDraft(next)
    if (next !== template) {
      updateSettings({ windowTitleTemplate: next })
    }
  }

  return (
    <>
      <SearchableSetting
        title={title}
        description={entry?.description}
        keywords={entry?.keywords ?? ['window title', 'time tracking']}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsSwitchRow
          label={title}
          description={translate(
            'settings.appearance.windowTitle.description',
            'Shows the active project, branch, and focused session in the window title so time trackers like ActivityWatch, Timing, WakaTime, and RescueTime can attribute your time. Screen recorders and apps with accessibility access can read window titles.'
          )}
          checked={enabled}
          onChange={() => updateSettings({ windowTitleShowWorkspace: !enabled })}
        />
      </SearchableSetting>

      {enabled ? (
        <>
          <SearchableSetting
            title={templateLabel}
            description={entry?.description}
            keywords={entry?.keywords ?? ['window title', 'template']}
            forceVisible={forceVisiblePrimary}
          >
            <SettingsRow
              label={templateLabel}
              description={
                <>
                  {translate(
                    'settings.appearance.windowTitle.templateHelp',
                    'Tokens: ${project} ${branch} ${workspace} ${tab} ${agent} ${app} ${separator}. Empty values drop their separator.'
                  )}
                  <span className="mt-1 block text-foreground">
                    {translate('settings.appearance.windowTitle.preview', 'Preview')}: {preview}
                  </span>
                </>
              }
              alignTop
              control={
                <div className="flex items-center gap-2">
                  <Input
                    value={templateDraft}
                    variant="code"
                    className="w-[320px]"
                    aria-label={templateLabel}
                    onChange={(event) => setTemplateDraft(event.target.value)}
                    onBlur={commitTemplate}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      }
                    }}
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={template === DEFAULT_WINDOW_TITLE_TEMPLATE}
                    onClick={() => {
                      setTemplateDraft(DEFAULT_WINDOW_TITLE_TEMPLATE)
                      updateSettings({ windowTitleTemplate: DEFAULT_WINDOW_TITLE_TEMPLATE })
                    }}
                  >
                    {translate('settings.appearance.windowTitle.reset', 'Reset')}
                  </Button>
                </div>
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title={separatorTitle}
            description={entry?.description}
            keywords={entry?.keywords ?? ['window title', 'separator']}
            forceVisible={forceVisiblePrimary}
          >
            <SettingsRow
              label={separatorTitle}
              control={
                <Select
                  value={separator}
                  onValueChange={(value) =>
                    updateSettings({ windowTitleSeparator: normalizeWindowTitleSeparator(value) })
                  }
                >
                  <SelectTrigger size="sm" className="min-w-[120px]" aria-label={separatorTitle}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEPARATOR_IDS.map((id) => (
                      <SelectItem key={id} value={id}>
                        {separatorLabel(id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </SearchableSetting>
        </>
      ) : null}
    </>
  )
}
