import type React from 'react'
import { Trash2 } from 'lucide-react'
import type { GlobalSettings, OpenWithApplication } from '../../../../shared/types'
import {
  normalizeOpenWithSettings,
  removeOpenWithApplication
} from '../../../../shared/open-with-applications'
import { Button } from '../ui/button'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { translate } from '@/i18n/i18n'

type OpenWithApplicationsSettingProps = {
  applications: OpenWithApplication[] | undefined
  defaults: Record<string, string> | undefined
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Extensions currently pinned to this app, for the "always open" hint line. */
function pinnedFileTypes(
  defaults: Record<string, string> | undefined,
  applicationId: string
): string[] {
  return Object.entries(defaults ?? {})
    .filter(([, id]) => id === applicationId)
    .map(([fileType]) => fileType)
    .sort()
}

export function OpenWithApplicationsSetting({
  applications,
  defaults,
  updateSettings
}: OpenWithApplicationsSettingProps): React.JSX.Element {
  const rows = applications ?? []

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'components.settings.openWithApplications.empty',
          'Apps you pick from the file explorer’s Open With menu show up here.'
        )}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {rows.map((application) => {
        const fileTypes = pinnedFileTypes(defaults, application.id)
        return (
          <div
            key={application.id}
            className="flex items-center gap-2 rounded-sm border border-border/60 px-2 py-1.5"
          >
            <OpenInApplicationIcon application={{ command: application.command }} size={14} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs">{application.label}</div>
              {fileTypes.length > 0 ? (
                <div className="truncate text-[11px] text-muted-foreground">
                  {translate(
                    'components.settings.openWithApplications.pinned',
                    'Default for {{types}}',
                    { types: fileTypes.join(', ') }
                  )}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label={translate(
                'components.settings.openWithApplications.remove',
                'Remove {{app}}',
                { app: application.label }
              )}
              onClick={() => {
                // Why: normalize together so rules pointing at the removed app
                // drop out instead of lingering as dead ids.
                updateSettings(
                  normalizeOpenWithSettings(
                    removeOpenWithApplication(rows, application.id),
                    defaults
                  )
                )
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
