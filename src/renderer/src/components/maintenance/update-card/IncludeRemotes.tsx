import {
  isPerfPrereleaseAppVersion,
  isPrereleaseAppVersion
} from '../../../../../shared/app-version'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function IncludeRemotes(): React.JSX.Element {
  const include = useAppStore((state) => state.includeRemotesInAppUpdate)
  const setInclude = useAppStore((state) => state.setIncludeRemotesInAppUpdate)
  const entries = useAppStore((state) => state.appUpdateCandidates)
  const openRemoteUpdates = useAppStore((state) => state.setRemoteServerUpdateDialogOpen)
  const checking = useAppStore((state) => state.appUpdateCandidatesChecking)
  const eligible = entries.filter((entry) => entry.supportsPinnedInstall)
  const legacy = entries.filter((entry) => !entry.supportsPinnedInstall)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={include}
            className="size-3.5"
            onCheckedChange={(value) => {
              setError(null)
              void setInclude(value === true).catch((cause: unknown) => setError(String(cause)))
            }}
          />
          {translate('updates.includeRemotes', 'Include remotes')}
        </label>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translate('updates.showRemotes', 'Show remotes that will be updated')}
          >
            <ChevronDown
              className={`size-3.5 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent animation="height">
        <div className="space-y-2 pt-2 text-xs text-muted-foreground">
          {checking ? (
            <p>{translate('updates.checkingRemotes', 'Checking remotes…')}</p>
          ) : eligible.length === 0 ? (
            <p>
              {translate('updates.noRemotes', 'No remotes can be included in this app update.')}
            </p>
          ) : (
            <>
              <ul className="max-h-40 space-y-2 overflow-y-auto scrollbar-sleek">
                {eligible.map((entry) => (
                  <li key={entry.environmentId} className="flex justify-between gap-3">
                    <span className="truncate">{entry.name}</span>
                    <span className="shrink-0 tabular-nums">
                      {entry.currentVersion} → {entry.targetVersion}
                    </span>
                  </li>
                ))}
              </ul>
              <p>
                {translate('updates.remoteDisconnectNotice', 'Remote tabs may briefly disconnect.')}
              </p>
            </>
          )}
          {legacy.length > 0 && (
            <div className="space-y-2">
              <p>
                {translate(
                  'updates.legacyRemotes',
                  'These remotes need one separate update before they can be included:'
                )}{' '}
                {legacy.map((entry) => entry.name).join(', ')}
              </p>
              <Button
                variant="link"
                size="xs"
                onClick={() => {
                  const version = legacy[0]?.targetVersion ?? ''
                  openRemoteUpdates(true, {
                    includePrerelease: isPrereleaseAppVersion(version),
                    includePerfPrerelease: isPerfPrereleaseAppVersion(version)
                  })
                }}
              >
                {translate('updates.updateOtherRemotes', 'Update these remotes')}
              </Button>
            </div>
          )}
        </div>
      </CollapsibleContent>
      {error && (
        <p role="alert" className="pt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </Collapsible>
  )
}
