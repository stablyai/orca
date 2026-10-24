import { useId } from 'react'
import { AlertTriangle, Check, Loader2, ShieldAlert } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { SecuritySurface } from '../../ui/security-surface'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'
import { formatKeybindingList } from '../../../../../shared/keybindings'
import { useAppStore } from '@/store'
import type { PluginTrust } from '../presentation/plugin-access-profile'
import { pluginTrustLabel, pluginTrustWarnings } from '../presentation/plugin-consent-copy'
import { PluginConsentProvenance, type PluginConsentSource } from './PluginConsentProvenance'
import { shadowedKeybindingTitles } from '../presentation/plugin-keybinding-conflicts'
import { PluginVmRecipeConsentPreview } from './PluginVmRecipeConsentPreview'
import type { PluginPageShortcut } from '../state/use-plugin-page-model'

type PluginInstallConsentProps = {
  name: string
  /** `install` grants on install; `enable` reviews a plugin already installed. */
  mode: 'install' | 'enable'
  trust: PluginTrust
  /** Null until the plugin's own files were read; the button stays off until then. */
  capabilities: readonly { kind: string; description: string }[] | null
  /** Shortcuts it binds; any that replace one of yours are named before consent. */
  shortcuts: readonly PluginPageShortcut[] | null
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

function shortcutPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Mac')) {
    return 'darwin'
  }
  return navigator.userAgent.includes('Windows') ? 'win32' : 'linux'
}

/**
 * What a plugin that runs code or instructions may do, right under the name and the one button
 * that grants it. On the host's security surface so a plugin theme cannot restyle the decision.
 */
export function PluginInstallConsent({
  name,
  mode,
  trust,
  capabilities,
  shortcuts,
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
  const headingId = useId()
  const ready = capabilities !== null
  const overrides = useAppStore((state) => state.keybindings)
  const platform = shortcutPlatform()
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
            {mode === 'install'
              ? translate(
                  'auto.components.settings.PluginInstallConsent.installHeading',
                  'If you install {{value0}}, it can:',
                  { value0: name }
                )
              : translate(
                  'auto.components.settings.PluginInstallConsent.enableHeading',
                  'If you enable {{value0}}, it can:',
                  { value0: name }
                )}
          </h3>
          <span className="shrink-0 rounded-md border border-border px-1.5 py-px text-2xs font-medium text-muted-foreground">
            {pluginTrustLabel(trust)}
          </span>
        </div>
        <div className="space-y-2 px-4 py-3 text-sm leading-6">
          {changed ? (
            <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs leading-5">
              {translate(
                'auto.components.settings.PluginConsentDialog.reconsent',
                'This plugin changed since you approved it. Review it to run it again.'
              )}
            </p>
          ) : null}
          {pluginTrustWarnings(trust).map((warning) => (
            <p key={warning} className="flex items-start gap-2">
              <AlertTriangle className="mt-1 size-4 shrink-0 text-muted-foreground" />
              <span>{warning}</span>
            </p>
          ))}
          {conflicts.map((conflict) => (
            <p key={conflict.key} className="flex items-start gap-2 text-status-warning-text">
              <AlertTriangle className="mt-1 size-4 shrink-0" />
              <span>
                {translate(
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
          {reading && !failed ? (
            // Why no verdict yet: "no other access" must wait for the files the button waits for.
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              {translate(
                'auto.components.settings.PluginDetailSections.accessLoading',
                'Reading the plugin…'
              )}
            </p>
          ) : ready && capabilities.length === 0 ? (
            // Why a row: the reading row it replaces keeps its height, so nothing below moves.
            <p className="flex items-start gap-2 text-muted-foreground">
              <Check className="mt-1 size-4 shrink-0" />
              {translate(
                'auto.components.settings.PluginInstallConsent.noOtherAccess',
                'It asks for no other access.'
              )}
            </p>
          ) : ready ? (
            capabilities.map((capability) => (
              <p key={capability.kind} className="flex items-start gap-2">
                <Check className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <span>
                  {pluginCapabilityDescription(capability.kind, capability.description)}{' '}
                  <span className="font-mono text-2xs text-muted-foreground">
                    ({capability.kind})
                  </span>
                </span>
              </p>
            ))
          ) : failed ? (
            <p className="flex items-center gap-2 text-status-warning-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">
                {translate(
                  'auto.components.settings.PluginDetailSections.accessFailed',
                  'Couldn’t read what it can access'
                )}
              </span>
              {onRetry ? (
                <Button variant="ghost" size="xs" onClick={onRetry}>
                  {translate('auto.components.settings.PluginDetailSections.retry', 'Retry')}
                </Button>
              ) : null}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              {translate(
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
          {reading && !failed ? (
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {translate(
                'auto.components.settings.PluginInstallConsent.reading',
                'Reading what it can access…'
              )}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {trust.worker
                ? translate(
                    'auto.components.settings.PluginInstallConsent.fullAccessUpdates',
                    'Updates that don’t ask for more access install without asking again, and can change what its full-access code does.'
                  )
                : translate(
                    'auto.components.settings.PluginInstallConsent.updatesKeepApproval',
                    'Updates that don’t ask for more access install without asking again.'
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
