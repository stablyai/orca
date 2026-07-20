import { AlertTriangle, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type {
  RuntimeUpdateGuide,
  RuntimeUpdateGuideLink,
  RuntimeUpdateGuideStep
} from '../../../../shared/runtime-update-guide'
import { NativeChatCopyButton } from '../native-chat/NativeChatCopyButton'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import { buildRuntimeUpdateAdvisorGuide } from './runtime-update-advisor-model'
import { useRuntimeReleaseMetadata } from './use-runtime-release-metadata'

/** 'checking' disables the button and shows a spinner; 'still-blocked' means the
 *  last recheck came back incompatible, so an inline note confirms the click had
 *  an effect even though the environment stays blocked. */
export type RuntimeUpdateRecheckState = 'idle' | 'checking' | 'still-blocked'

type RuntimeUpdateAdvisorProps = {
  verdict: RuntimeCompatVerdict
  status: RuntimeStatus
  portHint?: number
  recheckState: RuntimeUpdateRecheckState
  onRecheck: () => void
}

export function RuntimeUpdateAdvisor({
  verdict,
  status,
  portHint,
  recheckState,
  onRecheck
}: RuntimeUpdateAdvisorProps): React.JSX.Element | null {
  // Lazily fetched only for a shown server-too-old block; pending/failed → the
  // guide renders version-less. Manifest values win over server-supplied hints.
  const releaseMetadata = useRuntimeReleaseMetadata(verdict, status)
  const guide = buildRuntimeUpdateAdvisorGuide({ verdict, status, portHint, releaseMetadata })
  if (!guide) {
    return null
  }
  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <h4 className="text-sm font-semibold">{guide.title}</h4>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {guide.direction === 'client-too-old' ? guide.message : guide.primary}
          </p>
        </div>
      </div>
      {guide.direction === 'client-too-old' ? (
        <ClientUpdateAction />
      ) : (
        <ServerUpdateGuide guide={guide} />
      )}
      <RecheckRow recheckState={recheckState} onRecheck={onRecheck} />
    </div>
  )
}

// ── client-too-old: local updater only, never server commands ──────────

function ClientUpdateAction(): React.JSX.Element {
  // Why: the desktop updater surfaces its own progress/result via the global
  // UpdateCard, so triggering a check here is the whole action. Guarded because
  // web/mobile builds may not expose the updater — those get the release link.
  const canCheckForUpdates = typeof window.api.updater?.check === 'function'
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canCheckForUpdates ? (
        <Button
          type="button"
          variant="default"
          size="xs"
          className="gap-1.5"
          onClick={() => void window.api.updater.check({ includePrerelease: false })}
        >
          <Download className="size-3" />
          {translate(
            'auto.components.settings.RuntimeUpdateAdvisor.checkForUpdates',
            'Check for updates'
          )}
        </Button>
      ) : null}
      <AdvisorLink
        link={{
          label: translate(
            'auto.components.settings.RuntimeUpdateAdvisor.downloadOrca',
            'Download the latest Orca'
          ),
          url: 'https://github.com/stablyai/orca/releases'
        }}
      />
    </div>
  )
}

// ── server-too-old: versions, detection, copyable steps, links ─────────

function ServerUpdateGuide({
  guide
}: {
  guide: Extract<RuntimeUpdateGuide, { direction: 'server-too-old' }>
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <ServerUpdateMeta guide={guide} />
      {guide.steps.length > 0 ? (
        <ol className="space-y-2">
          {guide.steps.map((step, index) => (
            <li key={index}>
              <AdvisorStep step={step} />
            </li>
          ))}
        </ol>
      ) : null}
      {guide.links.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {guide.links.map((link) => (
            <AdvisorLink key={link.url} link={link} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ServerUpdateMeta({
  guide
}: {
  guide: Extract<RuntimeUpdateGuide, { direction: 'server-too-old' }>
}): React.JSX.Element {
  const protocolLine = translate(
    'auto.components.settings.RuntimeUpdateAdvisor.protocolLine',
    'Server protocol {{value0}}, this client requires {{value1}}.',
    {
      value0: guide.protocol.running,
      value1: guide.protocol.required ?? '—'
    }
  )
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p>{protocolLine}</p>
      {guide.detectedLine ? <p>{guide.detectedLine}</p> : null}
      {guide.serverVersion ? (
        <p>
          {translate(
            'auto.components.settings.RuntimeUpdateAdvisor.serverVersion',
            'Server version {{value0}}.',
            { value0: guide.serverVersion }
          )}
        </p>
      ) : null}
      {guide.latestVersion ? (
        <p>
          {translate(
            'auto.components.settings.RuntimeUpdateAdvisor.latestVersion',
            'Latest version {{value0}}.',
            { value0: guide.latestVersion }
          )}
        </p>
      ) : null}
    </div>
  )
}

function AdvisorStep({ step }: { step: RuntimeUpdateGuideStep }): React.JSX.Element {
  if (step.kind === 'prose') {
    return <p className="text-xs leading-relaxed text-muted-foreground">{step.text}</p>
  }
  // A command block is a suggestion for the user to run on the server (typically
  // over their own SSH session) — never a command Orca executes.
  return (
    <div className="relative rounded-md border border-border/60 bg-muted/40">
      <pre className="scrollbar-sleek overflow-x-auto whitespace-pre px-3 py-2 pr-9 font-mono text-xs leading-relaxed text-foreground">
        {step.text}
      </pre>
      <NativeChatCopyButton text={step.text} className="absolute right-1 top-1" />
    </div>
  )
}

function AdvisorLink({ link }: { link: RuntimeUpdateGuideLink }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto gap-1 px-0"
      onClick={() => void window.api.shell.openUrl(link.url)}
    >
      <ExternalLink className="size-3" />
      {link.label}
    </Button>
  )
}

function RecheckRow({
  recheckState,
  onRecheck
}: {
  recheckState: RuntimeUpdateRecheckState
  onRecheck: () => void
}): React.JSX.Element {
  const checking = recheckState === 'checking'
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="gap-1.5"
        onClick={onRecheck}
        disabled={checking}
      >
        {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        {translate('auto.components.settings.RuntimeUpdateAdvisor.checkAgain', 'Check again')}
      </Button>
      {recheckState === 'still-blocked' ? (
        <span className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimeUpdateAdvisor.stillOutOfDate',
            'Still out of date. Update the server, then check again.'
          )}
        </span>
      ) : null}
    </div>
  )
}
