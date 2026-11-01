import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { translate } from '@/i18n/i18n'

const ORCA_EDITOR_VALUE = '__orca-editor__'

type FileExplorerOpenInAppSettingProps = {
  applications: OpenInApplication[]
  selectedApplicationId: string | null | undefined
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Picks the app a File Explorer click opens files in; the Orca editor needs no app. */
export function FileExplorerOpenInAppSetting({
  applications,
  selectedApplicationId,
  updateSettings
}: FileExplorerOpenInAppSettingProps): React.JSX.Element | null {
  if (applications.length === 0) {
    return null
  }
  const selected = applications.find((application) => application.id === selectedApplicationId)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <div className="min-w-0 flex-1 space-y-1">
        <Label>
          {translate(
            'auto.components.settings.OpenInMenuSetting.fileExplorerClick',
            'Open files from File Explorer in'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.OpenInMenuSetting.fileExplorerClickDescription',
            'Choose where a click on a file opens it. Workspaces the app cannot reach open in the Orca editor.'
          )}
        </p>
      </div>
      <Select
        value={selected?.id ?? ORCA_EDITOR_VALUE}
        onValueChange={(value) =>
          updateSettings({
            fileExplorerOpenInApplicationId: value === ORCA_EDITOR_VALUE ? null : value
          })
        }
      >
        <SelectTrigger size="sm" density="compact" className="h-8 w-[180px] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ORCA_EDITOR_VALUE}>
            {translate('auto.components.settings.OpenInMenuSetting.orcaEditor', 'Orca editor')}
          </SelectItem>
          {applications.map((application) => (
            <SelectItem key={application.id} value={application.id}>
              <OpenInApplicationIcon application={application} size={14} />
              <span className="min-w-0 truncate">{application.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
