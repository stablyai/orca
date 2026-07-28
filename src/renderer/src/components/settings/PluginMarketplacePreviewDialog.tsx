import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { PluginCatalogAvatar } from '../plugin-catalog/PluginCatalogAvatar'
import { PluginConsentProvenance, type PluginConsentSource } from './PluginConsentProvenance'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { pluginCapabilityDescription } from './plugin-capability-presentation'

export type PluginMarketplacePreviewMode = 'install' | 'update'

type PluginMarketplacePreviewDialogProps = {
  preview: PluginMarketplaceHostInstallPreview | null
  mode: PluginMarketplacePreviewMode
  busy: boolean
  currentVersion: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}

function contributionSummary(
  preview: PluginMarketplaceHostInstallPreview
): { key: string; label: string }[] {
  const { contributes } = preview.manifest
  // Why: two static keys per kind (not one dynamic key) so the localization
  // catalog sync can extract them, and "1 icon themes" never renders.
  const entries: { key: string; count: number; one: string; many: string }[] = [
    {
      key: 'themes',
      count: contributes.themes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.themesOne',
        '1 app theme'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.themes',
        '{{value0}} app themes',
        { value0: contributes.themes.length }
      )
    },
    {
      key: 'iconThemes',
      count: contributes.iconThemes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.iconThemesOne',
        '1 icon theme'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.iconThemes',
        '{{value0}} icon themes',
        { value0: contributes.iconThemes.length }
      )
    },
    {
      key: 'terminalThemes',
      count: contributes.terminalThemes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.terminalThemesOne',
        '1 terminal theme'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.terminalThemes',
        '{{value0}} terminal themes',
        { value0: contributes.terminalThemes.length }
      )
    },
    {
      key: 'languagePacks',
      count: contributes.languagePacks.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.languagePacksOne',
        '1 language pack'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.languagePacks',
        '{{value0}} language packs',
        { value0: contributes.languagePacks.length }
      )
    },
    {
      key: 'commands',
      count: contributes.commands.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.commandsOne',
        '1 command'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.commands',
        '{{value0}} commands',
        { value0: contributes.commands.length }
      )
    },
    {
      key: 'keybindings',
      count: contributes.keybindings.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.keybindingsOne',
        '1 keyboard shortcut'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.keybindings',
        '{{value0}} keyboard shortcuts',
        { value0: contributes.keybindings.length }
      )
    },
    {
      key: 'vmRecipes',
      count: contributes.vmRecipes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.vmRecipesOne',
        '1 VM recipe'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.vmRecipes',
        '{{value0}} VM recipes',
        { value0: contributes.vmRecipes.length }
      )
    },
    {
      key: 'panels',
      count: contributes.panels.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.panelsOne',
        '1 panel'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.panels',
        '{{value0}} panels',
        { value0: contributes.panels.length }
      )
    },
    {
      key: 'events',
      count: contributes.events.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.eventsOne',
        '1 event subscription'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.events',
        '{{value0}} event subscriptions',
        { value0: contributes.events.length }
      )
    }
  ]
  const summary: { key: string; label: string }[] = entries
    .filter((entry) => entry.count > 0)
    .map(({ key, count, one, many }) => ({ key, label: count === 1 ? one : many }))
  if (preview.manifest.main) {
    summary.push({
      key: 'worker',
      label: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.worker',
        'Background worker'
      )
    })
  }
  return summary
}

export function PluginMarketplacePreviewDialog({
  preview,
  mode,
  busy,
  currentVersion,
  error,
  onClose,
  onConfirm
}: PluginMarketplacePreviewDialogProps): React.JSX.Element {
  const contributions = preview ? contributionSummary(preview) : []
  const blocked = preview?.blockedByKillList
  const provenanceSource: PluginConsentSource | undefined = preview
    ? {
        kind: preview.bundled ? 'bundled' : 'marketplace',
        reference: `${preview.source.url}#${preview.source.ref}`,
        resolvedCommit: preview.resolvedCommit,
        marketplace: {
          reference: preview.marketplaceName,
          resolvedCommit: preview.marketplaceCommit
        }
      }
    : undefined
  return (
    <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="plugin-security-chrome max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-sleek sm:max-w-xl">
        {preview ? (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3 pr-6">
                <PluginCatalogAvatar name={preview.manifest.name} className="mt-0.5" />
                <div className="min-w-0">
                  <DialogTitle className="truncate">{preview.manifest.name}</DialogTitle>
                  <DialogDescription className="mt-0.5 truncate">
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.versionLine',
                      'v{{value0}} · {{value1}}',
                      {
                        value0: preview.manifest.version,
                        value1: preview.marketplaceName
                      }
                    )}
                  </DialogDescription>
                  <div className="mt-1.5">
                    <PluginConsentProvenance
                      official={preview.official}
                      publisher={preview.manifest.publisher}
                      source={provenanceSource}
                    />
                  </div>
                </div>
              </div>
            </DialogHeader>
            {preview.manifest.description ? (
              <p className="text-sm leading-6">{preview.manifest.description}</p>
            ) : null}
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginMarketplacePreviewDialog.includes',
                  'Includes'
                )}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {contributions.length > 0 ? (
                  contributions.map((entry) => (
                    <Badge key={entry.key} variant="secondary">
                      {entry.label}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.noContributions',
                      'Manifest metadata only'
                    )}
                  </span>
                )}
              </div>
            </div>
            {preview.manifest.capabilities.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.capabilities',
                    'Requested access'
                  )}
                </p>
                {preview.manifest.capabilities.map((capability) => (
                  <div key={capability.kind} className="flex items-start gap-2 text-sm leading-6">
                    <Check className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      {pluginCapabilityDescription(capability.kind, capability.kind)}{' '}
                      <span className="font-mono text-[11px] text-muted-foreground">
                        ({capability.kind})
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {preview.manifest.main ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm leading-6">
                <AlertTriangle className="mt-1 size-4 shrink-0" />
                <span>
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.workerWarning',
                    "Capabilities limit how this plugin uses Orca's API. Its worker still runs as a normal process on this computer with full access to your files, network, and other processes."
                  )}
                </span>
              </div>
            ) : null}
            {blocked ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive">
                {translate(
                  'auto.components.settings.PluginMarketplacePreviewDialog.blocked',
                  "Orca's safety list blocks this plugin: {{value0}}",
                  { value0: blocked.reason }
                )}
              </p>
            ) : null}
            {currentVersion ? (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Check className="size-4 shrink-0" aria-hidden="true" />
                {translate(
                  'auto.components.settings.PluginMarketplacePreviewDialog.current',
                  'This exact plugin content is already installed.'
                )}
              </p>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              {currentVersion ? (
                <Button onClick={onClose}>
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.close',
                    'Close'
                  )}
                </Button>
              ) : (
                <>
                  <Button variant="ghost" disabled={busy} onClick={onClose}>
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.cancel',
                      'Cancel'
                    )}
                  </Button>
                  <Button disabled={busy || Boolean(blocked)} onClick={onConfirm}>
                    {busy ? <Loader2 className="animate-spin" /> : null}
                    {mode === 'update'
                      ? translate(
                          'auto.components.settings.PluginMarketplacePreviewDialog.update',
                          'Update plugin'
                        )
                      : translate(
                          'auto.components.settings.PluginMarketplacePreviewDialog.install',
                          'Install plugin'
                        )}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
