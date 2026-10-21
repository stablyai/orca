import { useEffect, useState } from 'react'
import { FolderOpen, Puzzle, RotateCw, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  BrowserExtensionActionResult,
  BrowserExtensionListing,
  BrowserExtensionListResult
} from '../../../../shared/browser-extension-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useConfirmationDialog } from '../confirmation-dialog-context'
import { describeUnsupportedBrowserExtensionFeatures } from '../browser-extension-permission-messages'
import { browserExtensionRemovalDescription } from '../browser-extension-removal-description'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getBrowserExtensionsSearchEntry } from './browser-extensions-search'
import { BrowserExtensionsWebStoreInstall } from './BrowserExtensionsWebStoreInstall'

type BrowserExtensionsSectionProps = {
  profileId: string
  profileLabel: string
}

function ExtensionRow({
  extension,
  busy,
  onToggle,
  onOpenOptions,
  onReload,
  onReviewUpdate,
  onRemove
}: {
  extension: BrowserExtensionListing
  busy: boolean
  onToggle: () => void
  onOpenOptions: () => void
  onReload: () => void
  onReviewUpdate: () => void
  onRemove: () => void
}): React.JSX.Element {
  const unsupported = describeUnsupportedBrowserExtensionFeatures(extension.permissions)
  const sourceLabel =
    extension.source === 'unpacked'
      ? translate('settings.browser.extensions.sourceUnpacked', 'Unpacked')
      : translate('settings.browser.extensions.sourceWebStore', 'Chrome Web Store')
  return (
    <div className="flex w-full items-center gap-3 rounded-md border border-border/70 px-3 py-2.5">
      {extension.iconDataUrl ? (
        <img src={extension.iconDataUrl} alt="" className="size-6 shrink-0 rounded-sm" />
      ) : (
        <Puzzle className="size-6 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{extension.name}</div>
        <p className="truncate text-2xs text-muted-foreground">
          {extension.version} · {sourceLabel}
        </p>
        {extension.heldUpdateVersion ? (
          <p className="text-2xs text-muted-foreground">
            {translate(
              'settings.browser.extensions.heldUpdate',
              'Version {{version}} is waiting for more access.',
              { version: extension.heldUpdateVersion }
            )}
          </p>
        ) : null}
        {unsupported ? <p className="text-2xs text-muted-foreground">{unsupported}</p> : null}
        {extension.loadError ? (
          <p className="text-2xs break-words text-destructive">
            {translate('settings.browser.extensions.loadError', 'Could not start: {{error}}', {
              error: extension.loadError
            })}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {extension.heldUpdateVersion ? (
          <Button variant="outline" size="xs" onClick={onReviewUpdate} disabled={busy}>
            {translate('settings.browser.extensions.reviewAccess', 'Review access')}
          </Button>
        ) : null}
        {extension.hasOptionsPage && extension.enabled ? (
          <Button variant="ghost" size="xs" onClick={onOpenOptions} disabled={busy}>
            <Settings2 className="size-3" />
            {translate('settings.browser.extensions.options', 'Options')}
          </Button>
        ) : null}
        <SettingsSwitch
          checked={extension.enabled}
          disabled={busy}
          ariaLabel={translate(
            'settings.browser.extensions.toggleLabel',
            'Turn {{name}} on or off',
            {
              name: extension.name
            }
          )}
          onChange={onToggle}
        />
        {extension.source === 'unpacked' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onReload}
                disabled={busy}
                aria-label={translate('settings.browser.extensions.reload', 'Reload from folder')}
              >
                <RotateCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('settings.browser.extensions.reload', 'Reload from folder')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRemove}
              disabled={busy}
              aria-label={translate('settings.browser.extensions.remove', 'Remove')}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('settings.browser.extensions.remove', 'Remove')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function BrowserExtensionsSection({
  profileId,
  profileLabel
}: BrowserExtensionsSectionProps): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const entry = getBrowserExtensionsSearchEntry()
  const [listing, setListing] = useState<{
    profileId: string
    result: BrowserExtensionListResult
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Why: the store page, the toolbar, updates and failed loads change the list outside Settings.
  useEffect(
    () => window.api.browser.onExtensionsChanged(() => setRevision((value) => value + 1)),
    []
  )

  useEffect(() => {
    let cancelled = false
    void window.api.browser.extensionsList({ profileId }).then((result) => {
      if (!cancelled) {
        setListing({ profileId, result })
      }
    })
    return () => {
      cancelled = true
    }
  }, [profileId, revision])

  const result = listing?.profileId === profileId ? listing.result : null
  const active = result?.active === true

  const run = async (
    busyKey: string,
    action: () => Promise<BrowserExtensionActionResult>
  ): Promise<void> => {
    setBusyId(busyKey)
    try {
      const outcome = await action()
      if (!outcome.ok) {
        toast.error(outcome.error)
      }
    } finally {
      setBusyId(null)
      setRevision((value) => value + 1)
    }
  }

  const loadUnpacked = async (): Promise<void> => {
    const directory = await window.api.shell.pickDirectory({})
    if (directory) {
      await run('load-unpacked', () =>
        window.api.browser.extensionsLoadUnpacked({ profileId, directory })
      )
    }
  }

  const remove = async (extension: BrowserExtensionListing): Promise<void> => {
    const confirmed = await confirm({
      title: translate('settings.browser.extensions.removeTitle', 'Remove {{name}}?', {
        name: extension.name
      }),
      description: browserExtensionRemovalDescription(extension.source),
      confirmLabel: translate('settings.browser.extensions.remove', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await run(extension.id, () =>
        window.api.browser.extensionsRemove({ profileId, extensionId: extension.id })
      )
    }
  }

  return (
    <SearchableSetting
      id="browser-extensions"
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.browser.extensions.profileDescription',
              'Extensions turned on here run in tabs that use the {{profile}} profile.',
              { profile: profileLabel }
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={!active || busyId !== null}
          onClick={() => void loadUnpacked()}
        >
          <FolderOpen className="size-3" />
          {translate('settings.browser.extensions.loadUnpacked', 'Load unpacked…')}
        </Button>
      </div>
      <BrowserExtensionsWebStoreInstall
        profileId={profileId}
        disabled={!active || busyId !== null}
        onFinished={() => setRevision((value) => value + 1)}
      />
      {active && result.extensions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.browser.extensions.empty',
            'No extensions installed. Add one from the Chrome Web Store above.'
          )}
        </p>
      ) : null}
      {active && result.extensions.length > 0 ? (
        <div className="space-y-2">
          {result.extensions.map((extension) => (
            <ExtensionRow
              key={extension.id}
              extension={extension}
              busy={busyId !== null}
              onToggle={() =>
                void run(extension.id, () =>
                  window.api.browser.extensionsSetEnabled({
                    profileId,
                    extensionId: extension.id,
                    enabled: !extension.enabled
                  })
                )
              }
              onOpenOptions={() =>
                void run(extension.id, () =>
                  window.api.browser.extensionsOpenOptions({ profileId, extensionId: extension.id })
                )
              }
              onReload={() =>
                void run(extension.id, () =>
                  window.api.browser.extensionsReload({ profileId, extensionId: extension.id })
                )
              }
              onReviewUpdate={() =>
                void run(extension.id, () =>
                  window.api.browser.extensionsReviewUpdate({
                    profileId,
                    extensionId: extension.id
                  })
                )
              }
              onRemove={() => void remove(extension)}
            />
          ))}
        </div>
      ) : null}
    </SearchableSetting>
  )
}
