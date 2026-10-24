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
import { PluginReviewBody, PluginReviewSection } from './plugin-review-dialog-layout'
import { pluginConsentTier } from './plugin-access-profile'
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
  switch (pluginConsentTier(plugin)) {
    case 'worker':
      return translate(
        'auto.components.settings.PluginConsentDialog.workerTrust',
        'Background worker — runs its own process'
      )
    case 'instructional':
      return translate(
        'auto.components.settings.PluginConsentDialog.instructionalTrust',
        'Instructional content — runs later under user or agent authority'
      )
    case 'panel':
      return translate(
        'auto.components.settings.PluginConsentDialog.panelTrust',
        'Panel or host-integrated content — no worker process'
      )
    case 'declarative':
      return translate(
        'auto.components.settings.PluginConsentDialog.declarativeTrust',
        'Declarative content — no plugin code'
      )
  }
}

/** Short one-word trust label for the header chip; the single warning below
 *  carries the full explanation. */
function trustTierShort(plugin: PluginHostListEntry): string {
  switch (pluginConsentTier(plugin)) {
    case 'worker':
      return translate('auto.components.settings.PluginConsentDialog.trustShortWorker', 'Worker')
    case 'instructional':
      return translate(
        'auto.components.settings.PluginConsentDialog.trustShortInstructional',
        'Instructional'
      )
    case 'panel':
      return translate('auto.components.settings.PluginConsentDialog.trustShortPanel', 'Panel')
    case 'declarative':
      return translate(
        'auto.components.settings.PluginConsentDialog.trustShortDeclarative',
        'Declarative'
      )
  }
}

function trustWarning(plugin: PluginHostListEntry): string {
  switch (pluginConsentTier(plugin)) {
    case 'worker':
      return translate(
        'auto.components.settings.PluginConsentDialog.warning',
        'Its worker runs as a normal process with full access to your files, network, and other processes.'
      )
    case 'instructional':
      return translate(
        'auto.components.settings.PluginConsentDialog.instructionalWarning',
        'Its commands and instructions can take actions when you or an agent use them.'
      )
    case 'panel':
      return translate(
        'auto.components.settings.PluginConsentDialog.panelWarning',
        'No background worker. These permissions limit what it can do in Orca.'
      )
    case 'declarative':
      return translate(
        'auto.components.settings.PluginConsentDialog.declarativeWarning',
        "Content only: no code, no background worker, and no access to Orca's API."
      )
  }
}

function consentTitle(plugin: PluginHostListEntry): string {
  const tier = pluginConsentTier(plugin)
  if (tier === 'declarative' && plugin.capabilities.length === 0) {
    return translate('auto.components.settings.PluginConsentDialog.reviewTitle', 'Review plugin')
  }
  if (tier !== 'instructional') {
    return translate('auto.components.settings.PluginConsentDialog.title', 'Review permissions')
  }
  if (plugin.capabilities.length > 0) {
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
        surface="security"
        className="max-h-[calc(100vh-3rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl"
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
              <div className="flex flex-wrap items-center gap-2 pt-1">
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
            </DialogHeader>
            <PluginReviewBody>
              <PluginReviewSection>
                <p className="flex items-start gap-2 text-sm leading-6">
                  <AlertTriangle className="mt-1 size-4 shrink-0" />
                  <span>{trustWarning(plugin)}</span>
                </p>
              </PluginReviewSection>
              {plugin.capabilities.length > 0 ? (
                <PluginReviewSection
                  title={translate(
                    'auto.components.settings.PluginConsentDialog.capabilities',
                    'This plugin can'
                  )}
                >
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
                </PluginReviewSection>
              ) : null}
              <PluginKeybindingConsentPreview commands={plugin.commands} />
              <PluginVmRecipeConsentPreview recipes={plugin.vmRecipes ?? []} />
              {plugin.needsReconsent ? (
                <PluginReviewSection
                  title={translate(
                    'auto.components.settings.PluginConsentDialog.whatChanged',
                    'What changed'
                  )}
                >
                  <p className="text-sm leading-6">
                    {translate(
                      'auto.components.settings.PluginConsentDialog.reconsent',
                      'This plugin changed since you approved it. Review it to run it again.'
                    )}
                  </p>
                </PluginReviewSection>
              ) : null}
            </PluginReviewBody>
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
