import { AlertTriangle, Loader2, RotateCw, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { PluginTrust } from './plugin-access-profile'
import { pluginTrustWarnings } from './plugin-consent-copy'
import { Button } from '../ui/button'
import { pluginCapabilityDescription } from './plugin-capability-presentation'
import type { PluginLogsState } from './use-plugin-logs'

export function DetailSection({
  title,
  count,
  children
}: {
  title: string
  count?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-baseline gap-2 px-0.5 text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {title}
        {count ? <span className="font-normal tracking-normal normal-case">{count}</span> : null}
      </h3>
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card/50 shadow-xs">
        {children}
      </div>
    </section>
  )
}

export function DetailRow({
  icon,
  title,
  detail,
  detailTone = 'default',
  trailing,
  wrap = false
}: {
  icon: React.ReactNode
  title: string
  detail?: React.ReactNode
  detailTone?: 'default' | 'warning' | 'destructive'
  trailing?: React.ReactNode
  /** Sentences, such as a trust warning, wrap instead of truncating. */
  wrap?: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-h-10 items-center gap-3 border-t border-border px-3.5 py-2 text-sm first:border-t-0">
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p data-wrap={wrap} className="truncate data-[wrap=true]:whitespace-normal">
          {title}
        </p>
        {detail ? (
          <p
            data-tone={detailTone}
            className="mt-px text-xs text-muted-foreground data-[tone=destructive]:text-destructive data-[tone=warning]:text-status-warning-text"
          >
            {detail}
          </p>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  )
}

/** What the plugin can reach, in the consent's words. */
export function PluginAccessSection({
  capabilities,
  trust,
  loading,
  failed = false,
  onRetry
}: {
  capabilities: readonly { kind: string; description: string }[] | null
  /** Null while unknown; never guessed from contributions alone. */
  trust: PluginTrust | null
  loading: boolean
  /** The manifest couldn't be read, so nothing is known about its access. */
  failed?: boolean
  onRetry?: () => void
}): React.JSX.Element {
  const unknown = trust === null
  // Why "own files" only then: a panel bounded by no capabilities is sandboxed; anything that
  // runs instructions or a worker reaches further, whatever it asks for.
  const ownFilesOnly =
    trust !== null && !trust.worker && !trust.instructional && capabilities?.length === 0
  return (
    <DetailSection
      title={translate('auto.components.settings.PluginDetailSections.access', 'Can access')}
    >
      {failed || (!loading && capabilities !== null && unknown) ? (
        // Why: an unreadable plugin must never read as one that needs no access.
        <DetailRow
          icon={<AlertTriangle />}
          title={translate(
            'auto.components.settings.PluginDetailSections.accessFailed',
            'Couldn’t read what it can access'
          )}
          detail={translate(
            'auto.components.settings.PluginDetailSections.accessFailedDetail',
            'Orca couldn’t fetch or check this plugin’s files.'
          )}
          detailTone="warning"
          trailing={
            failed && onRetry ? (
              <Button variant="ghost" size="xs" onClick={onRetry}>
                <RotateCw />
                {translate('auto.components.settings.PluginDetailSections.retry', 'Retry')}
              </Button>
            ) : null
          }
        />
      ) : loading || capabilities === null || trust === null ? (
        <DetailRow
          icon={<Loader2 className="animate-spin" />}
          title={translate(
            'auto.components.settings.PluginDetailSections.accessLoading',
            'Reading the plugin…'
          )}
        />
      ) : ownFilesOnly ? (
        <DetailRow
          icon={<ShieldCheck />}
          title={translate(
            'auto.components.settings.PluginDetailSections.noAccessReach',
            'Can’t reach anything outside its own files'
          )}
          detail={
            trust.panel
              ? translate(
                  'auto.components.settings.PluginDetailSections.noAccessCode',
                  'Its code runs in a sandbox with no extra access.'
                )
              : translate(
                  'auto.components.settings.PluginDetailSections.noAccessContent',
                  'Content only. It has no code that runs.'
                )
          }
        />
      ) : (
        <>
          {trust.worker || trust.instructional
            ? pluginTrustWarnings(trust).map((warning) => (
                <DetailRow key={warning} icon={<AlertTriangle />} wrap title={warning} />
              ))
            : null}
          {capabilities.map((capability) => (
            <DetailRow
              key={capability.kind}
              icon={<AlertTriangle />}
              title={pluginCapabilityDescription(capability.kind, capability.description)}
            />
          ))}
        </>
      )}
    </DetailSection>
  )
}

export function PluginLogsSection({
  state
}: {
  state: PluginLogsState | undefined
}): React.JSX.Element {
  const lines = state?.lines ?? []
  const text = lines
    .map(
      (entry) => `${new Date(entry.ts).toLocaleTimeString()} ${entry.level.padEnd(5)} ${entry.line}`
    )
    .join('\n')
  return (
    <DetailSection
      title={translate('auto.components.settings.PluginDetailSections.logs', 'Logs')}
      count={
        state?.lines
          ? translate(
              'auto.components.settings.PluginSettingsRow.logCount',
              'Last {{value0}} of up to 200 retained lines',
              {
                value0: lines.length
              }
            )
          : undefined
      }
    >
      {state?.loading ? (
        <p className="flex items-center gap-2 px-3.5 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {translate('auto.components.settings.PluginSettingsRow.loadingLogs', 'Loading logs…')}
        </p>
      ) : state?.error ? (
        <p className="px-3.5 py-3 text-xs text-destructive">{state.error}</p>
      ) : (
        <>
          <pre
            tabIndex={0}
            className="scrollbar-sleek max-h-44 overflow-auto bg-muted/40 px-3.5 py-2.5 font-mono text-2xs leading-5"
          >
            {text ||
              translate(
                'auto.components.settings.PluginSettingsRow.noLogs',
                'No log lines recorded.'
              )}
          </pre>
          {text ? (
            <div className="flex justify-end border-t border-border px-2 py-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void window.api.ui.writeClipboardText(text)}
              >
                {translate('auto.components.settings.PluginDetailSections.copyLogs', 'Copy')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </DetailSection>
  )
}
