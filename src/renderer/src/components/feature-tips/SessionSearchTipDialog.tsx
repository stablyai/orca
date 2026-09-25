import { useRef, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import type { FeatureTip } from '../../../../shared/feature-tips'
import {
  sessionSearchStatusDetails,
  sessionSearchStatusMessage
} from '@/components/settings/session-history-status-copy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { FeatureTipDialogFrame } from './FeatureTipDialogFrame'
import { SessionSearchFeatureTipVisual } from './SessionSearchFeatureTipVisual'
import type { SessionSearchTipStage } from './use-session-search-tip-setup'

function indexingProgressMessage(
  status: AiVaultSearchStatus | null,
  statusUnavailable: boolean
): string {
  if (statusUnavailable) {
    return translate('featureTips.sessionSearch.progressUnknown', 'Indexing your sessions…')
  }
  // Why: right after turning on, the indexer may not have started; the shared copy would call that unavailable.
  if (!status?.enabled || status.phase === 'idle' || status.phase === 'closed') {
    return translate('featureTips.sessionSearch.progressStarting', 'Finding your sessions…')
  }
  return sessionSearchStatusMessage(status)
}

function SettingsLine({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <span className="block text-muted-foreground">
      {translate(
        'featureTips.sessionSearch.consentInstruction',
        'Change or turn it off anytime in'
      )}{' '}
      <button
        type="button"
        onClick={onClick}
        className="inline appearance-none border-0 bg-transparent p-0 font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:decoration-foreground"
      >
        {translate('featureTips.sessionSearch.settingsLink', 'Settings → Agent Session Search')}
      </button>
      .
    </span>
  )
}

function OfferCopy({ tip }: { tip: FeatureTip }): JSX.Element {
  return (
    <>
      <span className="block">{tip.description}</span>
      <span className="block">
        {translate(
          'featureTips.sessionSearch.agentsInstruction',
          'Your agents can search it too. Ask one to “find the session where we fixed the login timeout.”'
        )}
      </span>
    </>
  )
}

function IndexingCopy({
  stage,
  status,
  statusUnavailable
}: {
  stage: 'indexing' | 'ready'
  status: AiVaultSearchStatus | null
  statusUnavailable: boolean
}): JSX.Element {
  const details = sessionSearchStatusDetails(status)
  return (
    <>
      <span className="block">
        {stage === 'ready'
          ? translate(
              'featureTips.sessionSearch.readyDescription',
              'Every agent session on this computer can now be found by what was said in it.'
            )
          : translate(
              'featureTips.sessionSearch.indexingDescription',
              'Orca is reading your past agent transcripts so you can search them. This can take a few minutes.'
            )}
      </span>
      <span className="block space-y-2" role="status" aria-live="polite">
        {stage === 'indexing' ? (
          // Why: the total grows as the pass discovers files, so this is indeterminate, never a percentage.
          <span className="block h-1 overflow-hidden rounded-full bg-secondary">
            <span className="block h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
          </span>
        ) : null}
        <span className="block text-xs font-medium tabular-nums text-foreground">
          {stage === 'ready' && status
            ? sessionSearchStatusMessage(status)
            : indexingProgressMessage(status, statusUnavailable)}
        </span>
        {details.map((line) => (
          <span key={line} className="block text-xs text-muted-foreground">
            {line}
          </span>
        ))}
      </span>
    </>
  )
}

export function SessionSearchTipDialog({
  open,
  tip,
  primaryBusy,
  onOpenChange,
  onPrimaryAction,
  onSettingsClick,
  stage,
  status,
  statusUnavailable
}: {
  open: boolean
  tip: FeatureTip
  primaryBusy: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSettingsClick: () => void
  stage: SessionSearchTipStage
  status: AiVaultSearchStatus | null
  statusUnavailable: boolean
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  let title: string = tip.title
  if (stage === 'indexing') {
    title = translate('featureTips.sessionSearch.indexingTitle', 'Indexing your agent sessions')
  } else if (stage === 'ready') {
    title = translate('featureTips.sessionSearch.readyTitle', 'Session search is ready')
  }
  const indexing = stage === 'indexing'

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        primaryButtonRef.current?.focus()
      }}
      visual={<SessionSearchFeatureTipVisual />}
    >
      <DialogHeader className="gap-4 text-left">
        <div>
          <Badge
            variant="outline"
            className="mb-3 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            {tip.eyebrow.toUpperCase()}
          </Badge>
          <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight md:text-[1.75rem]">
            {title}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed">
            {stage === 'offer' ? (
              <OfferCopy tip={tip} />
            ) : (
              <IndexingCopy stage={stage} status={status} statusUnavailable={statusUnavailable} />
            )}
            <SettingsLine onClick={onSettingsClick} />
          </DialogDescription>
        </div>
      </DialogHeader>

      <DialogFooter className="mt-8 flex sm:justify-stretch">
        <Button
          ref={primaryButtonRef}
          className="w-full"
          onClick={onPrimaryAction}
          disabled={primaryBusy}
        >
          {primaryBusy ? <Loader2 className="size-4 animate-spin" /> : null}
          {stage === 'offer' && !primaryBusy ? tip.ctaLabel : null}
          {stage === 'offer' && primaryBusy
            ? translate('featureTips.sessionSearch.turningOn', 'Turning on…')
            : null}
          {indexing
            ? translate('featureTips.sessionSearch.continueInBackground', 'Continue in background')
            : null}
          {stage === 'ready'
            ? translate('featureTips.sessionSearch.startSearching', 'Start searching')
            : null}
        </Button>
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}
