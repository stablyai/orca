import { useEffect, useState } from 'react'
import { Puzzle } from 'lucide-react'
import type { PluginFileTypeHostSuggestion } from '../../../../preload/api/plugin-host-api'
import { fileTypeOfPath } from '../../../../shared/plugins/plugin-file-type'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { requestPluginPreview } from '@/store/plugin-preview-request'
import { pluginDisplayNameFromKey } from '../plugins/list/plugin-display-name'
import { Button } from '../ui/button'

// Why module scope: "Not now" lasts for the session, across tabs and remounts.
const hiddenThisSession = new Set<string>()

/** Offers a catalog plugin for a file type Orca can't open or highlight. Never installs. */
export function PluginFileTypeSuggestion({
  filePath
}: {
  filePath: string
}): React.JSX.Element | null {
  const fileType = fileTypeOfPath(filePath)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [suggestion, setSuggestion] = useState<PluginFileTypeHostSuggestion | null>(null)
  const [hiddenFileType, setHiddenFileType] = useState<string | null>(null)
  const dismissed = settings?.pluginDismissedFileTypes ?? []
  const active =
    fileType !== null &&
    settings?.pluginSystemEnabled === true &&
    settings.pluginFileTypeSuggestions !== false &&
    !dismissed.includes(fileType) &&
    !hiddenThisSession.has(fileType)

  useEffect(() => {
    setSuggestion(null)
    if (!active || !fileType) {
      return
    }
    let current = true
    void window.api.plugins
      .suggestForFileType(fileType)
      .then((next) => {
        if (current) {
          setSuggestion(next)
        }
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [active, fileType])

  if (!active || !fileType || hiddenFileType === fileType || !suggestion) {
    return null
  }
  const name = suggestion.name ?? pluginDisplayNameFromKey(suggestion.pluginKey)
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-foreground">
          {translate(
            'auto.components.editor.PluginFileTypeSuggestion.message',
            'A plugin can open .{{value0}} files: {{value1}}',
            { value0: fileType, value1: name }
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            requestPluginPreview(suggestion)
            const state = useAppStore.getState()
            state.openSettingsTarget({ pane: 'plugins', repoId: null })
            state.openSettingsPage()
          }}
        >
          {translate('auto.components.editor.PluginFileTypeSuggestion.view', 'View plugin')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            hiddenThisSession.add(fileType)
            setHiddenFileType(fileType)
          }}
        >
          {translate('auto.components.editor.PluginFileTypeSuggestion.notNow', 'Not now')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() =>
            void updateSettings({ pluginDismissedFileTypes: [...dismissed, fileType] })
          }
        >
          {translate(
            'auto.components.editor.PluginFileTypeSuggestion.never',
            "Don't suggest for .{{value0}}",
            { value0: fileType }
          )}
        </Button>
      </div>
    </div>
  )
}
