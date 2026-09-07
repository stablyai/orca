import { useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { pluginConsentErrorMessage } from './plugin-error-presentation'
import { Button } from '../ui/button'
import { PluginVmRecipeConsentPreview } from './PluginVmRecipeConsentPreview'
import { PluginKeybindingConsentPreview } from './PluginKeybindingConsentPreview'
import { PluginConsentProvenance } from './PluginConsentProvenance'
import { pluginCapabilityDescription } from './plugin-capability-presentation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

type PluginConsentDialogProps = {
  plugin: PluginHostListEntry | null
  onDecision: (
    pluginKey: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ) => Promise<void>
}

function trustTier(plugin: PluginHostListEntry): string {
  if (plugin.hasWorker) {
    return translate(
      'auto.components.settings.PluginConsentDialog.workerTrust',
      'Background worker — runs its own process'
    )
  }
  if (hasInstructionalContent(plugin)) {
    return translate(
      'auto.components.settings.PluginConsentDialog.instructionalTrust',
      'Instructional content — runs later under user or agent authority'
    )
  }
  if (plugin.panels.length === 0 && plugin.capabilities.length === 0) {
    return translate(
      'auto.components.settings.PluginConsentDialog.declarativeTrust',
      'Declarative content — no plugin code'
    )
  }
  return translate(
    'auto.components.settings.PluginConsentDialog.panelTrust',
    'Panel or host-integrated content — no worker process'
  )
}

function hasInstructionalContent(plugin: PluginHostListEntry): boolean {
  return (
    (plugin.vmRecipes?.length ?? 0) > 0 ||
    plugin.commands.some((command) => command.keybindings.length > 0)
  )
}

/** Short one-word trust label for the header chip; the single warning below
 *  carries the full explanation. */
function trustTierShort(plugin: PluginHostListEntry): string {
  if (plugin.hasWorker) {
    return translate('auto.components.settings.PluginConsentDialog.trustShortWorker', 'Worker')
  }
  if (hasInstructionalContent(plugin)) {
    return translate(
      'auto.components.settings.PluginConsentDialog.trustShortInstructional',
      'Instructional'
    )
  }
  if (plugin.panels.length > 0 || plugin.capabilities.length > 0) {
    return translate('auto.components.settings.PluginConsentDialog.trustShortPanel', 'Panel')
  }
  return translate(
    'auto.components.settings.PluginConsentDialog.trustShortDeclarative',
    'Declarative'
  )
}

function consentTitle(plugin: PluginHostListEntry): string {
  if (!plugin.hasWorker && plugin.capabilities.length === 0 && !hasInstructionalContent(plugin)) {
    return translate('auto.components.settings.PluginConsentDialog.reviewTitle', 'Review plugin')
  }
  if (!hasInstructionalContent(plugin)) {
    return translate('auto.components.settings.PluginConsentDialog.title', 'Review permissions')
  }
  if (plugin.hasWorker || plugin.capabilities.length > 0) {
    return translate(
      'auto.components.settings.PluginConsentDialog.mixedTitle',
      'Review access and content'
    )
  }
  return translate(
    'auto.components.settings.PluginConsentDialog.instructionalTitle',
    'Review plugin content'
  )
}

export function PluginConsentDialog({
  plugin: currentPlugin,
  onDecision
}: PluginConsentDialogProps): React.JSX.Element {
  // Why: a same-key update must not replace the trust boundary while the user is reviewing it.
  const plugin = useRef(currentPlugin).current
  const keepDisabledRef = useRef<HTMLButtonElement>(null)
  const [busyDecision, setBusyDecision] = useState<'approve' | 'keep-disabled' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (decision: 'approve' | 'keep-disabled'): Promise<void> => {
    if (!plugin?.consentFingerprint || busyDecision) {
      return
    }
    setBusyDecision(decision)
    setError(null)
    try {
      // Why: consent is conditional on the exact trust boundary rendered by this dialog.
      await onDecision(plugin.pluginKey, plugin.consentFingerprint, decision)
    } catch (cause) {
      console.warn('[plugins] consent update failed:', cause)
      setError(pluginConsentErrorMessage(cause))
    } finally {
      setBusyDecision(null)
    }
  }

  return (
    <Dialog
      open={Boolean(plugin)}
      onOpenChange={(open) => {
        if (!open) {
          void decide('keep-disabled')
        }
      }}
    >
      <DialogContent
        className="plugin-security-chrome max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-sleek sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          // Why: dismissal is the safety-preserving path, so it receives initial focus.
          event.preventDefault()
          keepDisabledRef.current?.focus()
        }}
      >
        {plugin ? (
          <>
            <DialogHeader>
              <DialogTitle>{consentTitle(plugin)}</DialogTitle>
              <DialogDescription>
                {translate(
                  'auto.components.settings.PluginConsentDialog.subtitle',
                  '{{value0}} v{{value1}} · {{value2}}',
                  { value0: plugin.name, value1: plugin.version, value2: plugin.publisher }
                )}
              </DialogDescription>
            </DialogHeader>
            {plugin.needsReconsent ? (
              <p className="border-l-2 border-foreground/25 py-0.5 pl-3 text-sm leading-6">
                {translate(
                  'auto.components.settings.PluginConsentDialog.reconsent',
                  'Permissions, the worker trust tier, or instructional content changed since you last reviewed this plugin. Review it again before it can run.'
                )}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <PluginConsentProvenance
                official={plugin.official}
                publisher={plugin.publisher}
                source={plugin.source}
              />
              <span
                className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                title={trustTier(plugin)}
              >
                {trustTierShort(plugin)}
              </span>
            </div>
            {plugin.capabilities.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginConsentDialog.capabilities',
                    'This plugin can'
                  )}
                </p>
                <div className="space-y-2">
                  {plugin.capabilities.map((capability) => (
                    <div key={capability.kind} className="flex items-start gap-2 text-sm leading-6">
                      <Check className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                      <span>
                        {pluginCapabilityDescription(capability.kind, capability.description)}{' '}
                        <span className="font-mono text-[11px] text-muted-foreground">
                          ({capability.kind})
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm leading-6">
              <AlertTriangle className="mt-1 size-4 shrink-0" />
              <span>
                {plugin.hasWorker
                  ? translate(
                      'auto.components.settings.PluginConsentDialog.warning',
                      "These permissions limit how the plugin uses Orca's API. Its worker still runs as a normal process on your computer with full access to your files, network, and other processes."
                    )
                  : hasInstructionalContent(plugin)
                    ? translate(
                        'auto.components.settings.PluginConsentDialog.instructionalWarning',
                        'This plugin has no worker process. Its instructional content can still cause actions when you or an agent use it. Review the instructions and commands below before enabling it.'
                      )
                    : plugin.capabilities.length > 0 || plugin.panels.length > 0
                      ? translate(
                          'auto.components.settings.PluginConsentDialog.panelWarning',
                          "These permissions limit how the plugin uses Orca's API. This plugin has no background worker."
                        )
                      : translate(
                          'auto.components.settings.PluginConsentDialog.declarativeWarning',
                          "This plugin contributes validated content only. It does not run a background worker or receive access to Orca's API."
                        )}
              </span>
            </div>
            <PluginKeybindingConsentPreview commands={plugin.commands} />
            <PluginVmRecipeConsentPreview recipes={plugin.vmRecipes ?? []} />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button
                ref={keepDisabledRef}
                variant="ghost"
                size="sm"
                disabled={Boolean(busyDecision)}
                onClick={() => void decide('keep-disabled')}
              >
                {busyDecision === 'keep-disabled' ? <Loader2 className="animate-spin" /> : null}
                {translate(
                  'auto.components.settings.PluginConsentDialog.keepDisabled',
                  'Keep Disabled'
                )}
              </Button>
              <Button
                size="sm"
                disabled={Boolean(busyDecision)}
                onClick={() => void decide('approve')}
              >
                {busyDecision === 'approve' ? <Loader2 className="animate-spin" /> : null}
                {translate('auto.components.settings.PluginConsentDialog.enable', 'Enable plugin')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
