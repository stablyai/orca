import { useId } from 'react'
import { AlertTriangle, Check, Loader2, ShieldAlert } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { getIntlLocale } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { Button } from '../../ui/button'
import { SecuritySurface } from '../../ui/security-surface'
import {
  pluginCapabilityDescription,
  shownPluginCapabilities
} from '../presentation/plugin-capability-presentation'
import { formatKeybindingList } from '../../../../../shared/keybindings'
import { useAppStore } from '@/store'
import type { PluginTrust } from '../presentation/plugin-access-profile'
import { pluginTrustLabel, pluginTrustWarnings } from '../presentation/plugin-consent-copy'
import { PluginConsentProvenance, type PluginConsentSource } from './PluginConsentProvenance'
import { shadowedKeybindingTitles } from '../presentation/plugin-keybinding-conflicts'
import { PluginVmRecipeConsentPreview } from './PluginVmRecipeConsentPreview'
import type { PluginPageReplacement, PluginPageShortcut } from '../state/use-plugin-page-model'
import { builtInActionTitle } from '../page/PluginCommandReplacementRow'

type PluginInstallConsentProps = {
  trust: PluginTrust
  /** Null until the plugin's own files were read; the button stays off until then. */
  capabilities: readonly { kind: string; description: string }[] | null
  /** Shortcuts it binds; any that replace one of yours are named before consent. */
  shortcuts: readonly PluginPageShortcut[] | null
  /** Commands that run in place of Orca's own actions. */
  replacements?: readonly PluginPageReplacement[] | null
  /** Dotted file suffixes its custom editors open and edit. */
  editorFileTypes?: readonly string[] | null
  /** Its files are still being read; says so beside the disabled button. */
  reading?: boolean
  /** Its files couldn't be read, so nothing is known about what it can do. */
  failed?: boolean
  onRetry?: () => void
  /** Installed only: its exact commands, shortcuts and recipe commands. */
  installed: PluginHostListEntry | null
  official: boolean
  publisher: string
  source?: PluginConsentSource
  /** The plugin changed since it was last approved, or since this page was opened. */
  changed: boolean
  error: string | null
}

function formatFileTypeList(
  fileTypes: readonly string[],
  intlLocale: string = getIntlLocale()
): string {
  try {
    return new Intl.ListFormat(intlLocale, { type: 'conjunction' }).format(fileTypes)
  } catch {
    return fileTypes.join(', ')
  }
}

/**
 * What a plugin that runs code or instructions may do, right under the name and the one button
 * that grants it. On the host's security surface so a plugin theme cannot restyle the decision.
 */
export function PluginInstallConsent({
  trust,
  capabilities: requested,
  shortcuts,
  replacements,
  editorFileTypes,
  reading = false,
  failed = false,
  onRetry,
  installed,
  official,
  publisher,
  source,
  changed,
  error
}: PluginInstallConsentProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const headingId = useId()
  const capabilities = requested ? shownPluginCapabilities(requested, trust) : null
  const ready = capabilities !== null
  const overrides = useAppStore((state) => state.keybindings)
  const platform = getShortcutPlatform()
  const conflicts = (shortcuts ?? []).flatMap((shortcut) => {
    const replaced = shadowedKeybindingTitles(shortcut.key, platform, overrides)
    return replaced.length > 0 ? [{ ...shortcut, replaced }] : []
  })
  return (
    <SecuritySurface>
      <section
        aria-labelledby={headingId}
        data-plugin-consent=""
        className="mt-5 overflow-hidden rounded-xl border border-foreground/25 bg-card text-card-foreground shadow-xs"
      >
        <div className="flex items-center gap-2 border-b border-foreground/15 bg-muted px-4 py-2.5">
          <ShieldAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 id={headingId} className="min-w-0 flex-1 text-sm font-medium">
            {t('auto.components.settings.PluginDetailSections.access', 'Can access')}
          </h3>
          <span className="shrink-0 rounded-md border border-border px-1.5 py-px text-2xs font-medium text-muted-foreground">
            {!trust.worker && !trust.declarative && (editorFileTypes?.length ?? 0) > 0
              ? t(
                  'auto.components.settings.pluginConsentCopy.opensAndEditsFiles',
                  'Opens and edits files'
                )
              : pluginTrustLabel(trust, t)}
          </span>
        </div>
        <div className="space-y-2 px-4 py-3 text-sm leading-6">
          {changed ? (
            <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs leading-5">
              {t(
                'auto.components.settings.PluginConsentDialog.reconsent',
                'Changed since you approved it'
              )}
            </p>
          ) : null}
          {pluginTrustWarnings(trust, t).map((warning) => (
            <p key={warning} className="flex items-start gap-2">
              <AlertTriangle className="mt-1 size-4 shrink-0 text-muted-foreground" />
              <span>{warning}</span>
            </p>
          ))}
          {editorFileTypes && editorFileTypes.length > 0 ? (
            <p className="flex items-start gap-2">
              <Check className="mt-1 size-4 shrink-0 text-muted-foreground" />
              <span>
                {t(
                  'auto.components.settings.PluginInstallConsent.editsFileTypes',
                  'Opens and edits {{value0}} files in Orca. It can read the files it opens.',
                  { value0: formatFileTypeList(editorFileTypes, intlLocale) }
                )}
              </span>
            </p>
          ) : null}
          {conflicts.map((conflict) => (
            <p key={conflict.key} className="flex items-start gap-2 text-status-warning-text">
              <AlertTriangle className="mt-1 size-4 shrink-0" />
              <span>
                {t(
                  'auto.components.settings.PluginInstallConsent.replacesShortcut',
                  '{{value0}} ({{value1}}) replaces your shortcut for {{value2}}.',
                  {
                    value0: formatKeybindingList([conflict.key], platform),
                    value1: conflict.command,
                    value2: conflict.replaced.join(', ')
                  }
                )}
              </span>
            </p>
          ))}
          {(replacements ?? []).map((replacement) => (
            <p key={replacement.action} className="flex items-start gap-2 text-status-warning-text">
              <AlertTriangle className="mt-1 size-4 shrink-0" />
              <span>
                {t(
                  'auto.components.settings.PluginInstallConsent.replacesAction',
                  '{{value0}} runs instead of Orca’s {{value1}}. You can switch it back in its plugin page.',
                  { value0: replacement.command, value1: builtInActionTitle(replacement.action) }
                )}
              </span>
            </p>
          ))}
          {reading && !failed ? (
            // Why no verdict yet: "no other access" must wait for the files the button waits for.
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              {t(
                'auto.components.settings.PluginDetailSections.accessLoading',
                'Reading the plugin…'
              )}
            </p>
          ) : ready && capabilities.length === 0 ? (
            // Why a row: the reading row it replaces keeps its height, so nothing below moves.
            <p className="flex items-start gap-2 text-muted-foreground">
              <Check className="mt-1 size-4 shrink-0" />
              {t('auto.components.settings.PluginInstallConsent.noOtherAccess', 'No other access')}
            </p>
          ) : ready ? (
            capabilities.map((capability) => (
              <p key={capability.kind} className="flex items-start gap-2" title={capability.kind}>
                <Check className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <span>
                  {pluginCapabilityDescription(capability.kind, capability.description, t)}
                </span>
              </p>
            ))
          ) : failed ? (
            <p className="flex items-center gap-2 text-status-warning-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">
                {t(
                  'auto.components.settings.PluginDetailSections.accessFailed',
                  'Couldn’t read its access'
                )}
              </span>
              {onRetry ? (
                <Button variant="ghost" size="xs" onClick={onRetry}>
                  {t('auto.components.settings.PluginDetailSections.retry', 'Retry')}
                </Button>
              ) : null}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              {t(
                'auto.components.settings.PluginDetailSections.accessLoading',
                'Reading the plugin…'
              )}
            </p>
          )}
          {installed ? <PluginVmRecipeConsentPreview recipes={installed.vmRecipes ?? []} /> : null}
        </div>
        {error ? <p className="px-4 pb-2 text-xs text-destructive">{error}</p> : null}
        {/* Why no button here: the page's one decision sits top-right, beside the name. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
          {reading && !failed ? null : (
            <span className="text-xs text-muted-foreground">
              {trust.worker
                ? t(
                    'auto.components.settings.PluginInstallConsent.fullAccessUpdates',
                    'Updates can change its code without asking'
                  )
                : t(
                    'auto.components.settings.PluginInstallConsent.updatesKeepApproval',
                    'Updates ask again only for new access'
                  )}
            </span>
          )}
          <div className="ml-auto">
            <PluginConsentProvenance official={official} publisher={publisher} source={source} />
          </div>
        </div>
      </section>
    </SecuritySurface>
  )
}
