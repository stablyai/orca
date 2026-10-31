import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { installedPluginTrust } from '../presentation/plugin-access-profile'
import { pluginConsentErrorMessage } from '../presentation/plugin-error-presentation'
import { pluginNeedsReview } from '../presentation/plugin-status-presentation'
import { PluginDetailAlert } from './PluginDetailAlert'
import { PluginInstallConsent } from '../review/PluginInstallConsent'
import { PluginThemeUseNow } from './PluginThemeUseNow'
import type { usePluginInstallAction } from '../state/use-plugin-install-action'
import { usePluginInUse } from '../state/use-plugin-in-use'
import { PluginInUseAction } from '../catalog/PluginInUseAction'
import { installButtonLabel } from '../catalog/PluginCardAction'
import type { usePluginPageModel } from '../state/use-plugin-page-model'

type PluginPageActionProps = {
  entry: PluginListEntry
  /** The name the page shows: the manifest's once read, else the catalog's. */
  name: string
  model: ReturnType<typeof usePluginPageModel>
  unavailable: boolean
  busy: boolean
  install: ReturnType<typeof usePluginInstallAction>
  onConsent: (
    pluginKey: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ) => Promise<void>
}

/** Where the page's decision renders: top-right beside the name, the status line under the
 *  publisher, and what must be read before deciding, directly under the header. */
type PluginPageActionParts = {
  /** Top-right, beside the title; null leaves the slot to the installed controls. */
  header: React.ReactNode
  /** The line under the publisher, reserved on every page. */
  status: React.ReactNode
  body: React.ReactNode
}

function ContentOnlyNote(): React.JSX.Element {
  return (
    <span className="plugin-security-chrome inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      {translate('auto.components.settings.PluginPageAction.contentOnly', 'Content only')}
    </span>
  )
}

/** A theme reserves its "Use now" line from first paint, so installing never moves the page. */
function UseNowLine({
  pluginKey,
  reserved
}: {
  pluginKey: string | null
  reserved: boolean
}): React.JSX.Element | null {
  if (!reserved) {
    return null
  }
  return (
    <div data-use-now-line="" className="mt-3 flex min-h-7 items-center">
      {pluginKey ? <PluginThemeUseNow pluginKey={pluginKey} /> : null}
    </div>
  )
}

/**
 * The page's one decision: Install for content only, Install & enable above its consent for
 * anything else, or Enable for an installed plugin waiting for review. Nothing opens a dialog.
 */
export function usePluginPageAction({
  entry,
  name,
  model,
  unavailable,
  busy,
  install,
  onConsent
}: PluginPageActionProps): PluginPageActionParts {
  const [consentError, setConsentError] = useState<string | null>(null)
  const { plugin, listing, execution, preview, trust } = model
  const inUse = usePluginInUse(plugin?.pluginKey ?? null)
  const phase = install.phaseOf(entry.pluginKey)
  const themed = entry.types.some(
    (type) => type === 'app-theme' || type === 'icon-theme' || type === 'terminal-theme'
  )
  const none: PluginPageActionParts = { header: null, status: null, body: null }

  if (plugin && pluginNeedsReview(plugin) && plugin.consentFingerprint) {
    const fingerprint = plugin.consentFingerprint
    const decide = (decision: 'approve' | 'keep-disabled'): void => {
      setConsentError(null)
      void onConsent(plugin.pluginKey, fingerprint, decision).catch((cause: unknown) => {
        console.warn('[plugins] consent update failed:', cause)
        setConsentError(pluginConsentErrorMessage(cause))
      })
    }
    const enableLabel = translate(
      'auto.components.settings.PluginConsentDialog.enable',
      'Enable plugin'
    )
    return {
      ...none,
      header: (
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => decide('keep-disabled')}>
            {translate('auto.components.settings.PluginInstallConsent.keepOff', 'Keep off')}
          </Button>
          <Button
            size="sm"
            className="w-36"
            disabled={busy}
            aria-label={`${enableLabel}: ${plugin.name}`}
            onClick={() => decide('approve')}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {enableLabel}
          </Button>
        </>
      ),
      body: (
        <PluginInstallConsent
          trust={trust ?? installedPluginTrust(plugin, null)}
          capabilities={plugin.capabilities}
          shortcuts={model.shortcuts}
          editorFileTypes={model.editorFileTypes}
          installed={plugin}
          official={plugin.official}
          publisher={plugin.publisher}
          source={plugin.source}
          changed={plugin.needsReconsent}
          error={consentError}
        />
      )
    }
  }

  if (plugin) {
    return {
      ...none,
      header: (
        <PluginInUseAction pluginKey={plugin.pluginKey} name={name} inUse={inUse} size="sm" />
      ),
      status: plugin.execution === 'data' ? <ContentOnlyNote /> : null,
      body: <UseNowLine pluginKey={plugin.pluginKey} reserved={themed} />
    }
  }

  if (!listing || unavailable) {
    return none
  }
  const installing = phase?.kind === 'installing'
  const errorAlert =
    phase?.kind === 'error' ? (
      <PluginDetailAlert
        tone="destructive"
        title={translate(
          'auto.components.settings.PluginPageAction.failedTitle',
          'Couldn’t install {{value0}}',
          { value0: name }
        )}
        body={phase.message}
      />
    ) : null

  if (execution === 'data') {
    return {
      ...none,
      header: (
        <Button
          size="sm"
          className="w-36"
          disabled={installing || model.disarmed}
          aria-label={translate(
            'auto.components.settings.PluginManagerRows.installName',
            'Install {{value0}}',
            { value0: name }
          )}
          onClick={() => void install.install(listing, preview ? { preview } : undefined)}
        >
          {installing ? <Loader2 className="animate-spin" /> : null}
          {installButtonLabel(phase)}
        </Button>
      ),
      status: <ContentOnlyNote />,
      body: (
        <>
          <UseNowLine pluginKey={null} reserved={themed} />
          {errorAlert}
        </>
      )
    }
  }

  // Why the preview: it carries the fingerprint approved, and must be the release shown.
  const armed = preview !== null && !model.disarmed
  const installLabel = translate(
    'auto.components.settings.PluginInstallConsent.install',
    'Install & enable'
  )
  return {
    ...none,
    header: (
      <Button
        size="sm"
        className="w-36"
        disabled={!armed || installing}
        aria-label={`${installLabel}: ${name}`}
        onClick={() => {
          if (preview && !model.disarmed) {
            void install.install(listing, { preview })
          }
        }}
      >
        {installing ? <Loader2 className="animate-spin" /> : null}
        {installLabel}
      </Button>
    ),
    body: (
      <>
        <PluginInstallConsent
          trust={trust ?? installedPluginTrust({ panels: [], hasWorker: false }, null)}
          capabilities={model.capabilities}
          shortcuts={model.shortcuts}
          editorFileTypes={model.editorFileTypes}
          reading={preview === null && !model.stale}
          failed={model.previewFailed}
          onRetry={model.retryPreview}
          installed={null}
          official={listing.official}
          publisher={entry.publisher ?? ''}
          changed={false}
          error={null}
        />
        {errorAlert}
      </>
    )
  }
}
