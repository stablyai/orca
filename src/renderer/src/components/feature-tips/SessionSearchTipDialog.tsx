import { useRef, type JSX } from 'react'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import type { FeatureTip } from '../../../../shared/feature-tips'
import {
  sessionSearchStatusDetails,
  sessionSearchStatusMessage
} from '@/components/settings/session-history-status-copy'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'
import { SessionSearchFeatureTipVisual } from './SessionSearchFeatureTipVisual'
import type { SessionSearchTipStage } from './use-session-search-tip-setup'

function stageCopy(
  tip: FeatureTip,
  stage: SessionSearchTipStage
): { title: string; description: string; cta: string } {
  switch (stage) {
    case 'offer':
      return { title: tip.title, description: tip.description, cta: tip.ctaLabel }
    case 'indexing':
      return {
        title: translate('featureTips.sessionSearch.indexingTitle', 'Indexing your agent sessions'),
        description: translate(
          'featureTips.sessionSearch.indexingDescription',
          'Orca is reading your past agent transcripts so you can search them. This can take a few minutes.'
        ),
        cta: translate('featureTips.sessionSearch.continueInBackground', 'Continue in background')
      }
    case 'ready':
      return {
        title: translate('featureTips.sessionSearch.readyTitle', 'Session search is ready'),
        description: translate(
          'featureTips.sessionSearch.readyDescription',
          'Every agent session on this computer can now be found by what was said in it.'
        ),
        cta: translate('featureTips.sessionSearch.startSearching', 'Start searching')
      }
  }
}

function progressMessage(status: AiVaultSearchStatus | null): string {
  // Why: right after turning on, the indexer may not have started; the shared copy would call that unavailable.
  if (!status?.enabled || status.phase === 'idle' || status.phase === 'closed') {
    return translate('featureTips.sessionSearch.progressStarting', 'Finding your sessions…')
  }
  return sessionSearchStatusMessage(status)
}

function IndexProgress({
  indexing,
  status
}: {
  indexing: boolean
  status: AiVaultSearchStatus | null
}): JSX.Element {
  return (
    <span className="block space-y-2" role="status" aria-live="polite">
      {indexing ? (
        // Why: the total grows as the pass discovers files, so this is indeterminate, never a percentage.
        <span className="block h-1 overflow-hidden rounded-full bg-secondary">
          <span className="block h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        </span>
      ) : null}
      <span className="block text-xs font-medium tabular-nums text-foreground">
        {progressMessage(status)}
      </span>
      {sessionSearchStatusDetails(status).map((line) => (
        <span key={line} className="block text-xs text-muted-foreground">
          {line}
        </span>
      ))}
    </span>
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
  status
}: {
  open: boolean
  tip: FeatureTip
  primaryBusy: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSettingsClick: () => void
  stage: SessionSearchTipStage
  status: AiVaultSearchStatus | null
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const copy = stageCopy(tip, stage)

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
          <FeatureTipEyebrow label={tip.eyebrow} />
          <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight md:text-[1.75rem]">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed">
            <span className="block">{copy.description}</span>
            {stage === 'offer' ? (
              <span className="block">
                {translate(
                  'featureTips.sessionSearch.agentsInstruction',
                  'Your agents can search it too. Ask one to “find the session where we fixed the login timeout.”'
                )}
              </span>
            ) : (
              <IndexProgress indexing={stage === 'indexing'} status={status} />
            )}
            <FeatureTipSettingsLine
              lead={translate(
                'featureTips.sessionSearch.consentInstruction',
                'Change or turn it off anytime in'
              )}
              link={translate(
                'featureTips.sessionSearch.settingsLink',
                'Settings → Agent Session Search'
              )}
              onClick={onSettingsClick}
            />
          </DialogDescription>
        </div>
      </DialogHeader>

      <DialogFooter className="mt-8 flex sm:justify-stretch">
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={primaryBusy}
          onPrimaryAction={onPrimaryAction}
          onSkip={() => onOpenChange(false)}
          showSkip={false}
          fullWidth
          primaryButtonRef={primaryButtonRef}
          label={copy.cta}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}
