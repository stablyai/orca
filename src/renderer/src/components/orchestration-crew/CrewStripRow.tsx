import { memo } from 'react'
import { ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { CrewRowDetails, CrewRowTime } from './CrewRowDetails'
import { CrewAgentIcons, type CrewRowLook } from './CrewAgentIcons'
import { IconButton } from './CrewRowView'

/** The one-line preview: an approval of yours, else the latest message. */
function crewRowPreview(
  row: OrchestrationCrewRow,
  look: CrewRowLook,
  t: Translate
): { text: string; at?: string; warning: boolean } {
  if (look.status === 'permission') {
    const approval = row.approvals?.find((entry) => entry.approval.state === 'open')
    const what = approval?.approval.summary.title ?? row.latest?.preview ?? ''
    return {
      text: t(
        'auto.components.NativeChatResumeOnRestartModal.activityApproval',
        'Waiting for your approval: {{value0}}',
        { value0: what }
      ),
      at: approval?.at ?? row.latest?.at,
      warning: true
    }
  }
  if (!row.latest) {
    return { text: '', warning: false }
  }
  return {
    text:
      row.latest.direction === 'to'
        ? t('components.orchestrationCrew.youPreview', 'You: {{preview}}', {
            preview: row.latest.preview
          })
        : row.latest.preview,
    at: row.latest.at,
    warning: false
  }
}

/** A manager, worker or peer in the agents strip: one line, clicked to mention, details under ›. */
export const CrewStripRow = memo(function CrewStripRow({
  row,
  look,
  target,
  badge,
  canMention,
  mention,
  expanded,
  toggle
}: {
  row: OrchestrationCrewRow
  look: CrewRowLook
  target: RuntimeClientTarget
  /** "Worker" where rows of several kinds mix. */
  badge?: string
  canMention: boolean
  mention: (row: OrchestrationCrewRow, look: CrewRowLook) => void
  expanded: boolean
  toggle: (partyKey: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  // memo() skips the parent re-render a language switch relies on.
  useUiLanguageRevision()
  const preview = crewRowPreview(row, look, t)
  const mentionable = canMention && Boolean(row.sendAddress)
  const open = () => void openOrchestrationCrewAgent(row, target)
  // Only a row that can't take a click explains itself on hover.
  const unavailable = !row.sendAddress
    ? t('components.orchestrationCrew.sendingUnavailable', 'Sending unavailable')
    : !canMention
      ? t(
          'components.orchestrationCrew.composerUnavailable',
          "The message box can't take a mention now"
        )
      : null
  const main = (
    <button
      type="button"
      aria-disabled={!mentionable || undefined}
      aria-label={
        mentionable
          ? t('components.orchestrationCrew.mentionTip', 'Mention {{name}}', { name: row.label })
          : undefined
      }
      className={cn(
        '-mx-1 flex h-6 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mentionable ? 'cursor-pointer hover:bg-accent' : 'cursor-default'
      )}
      // Keep focus in the composer the mention lands in.
      onPointerDown={(event) => event.preventDefault()}
      onClick={mentionable ? () => mention(row, look) : undefined}
    >
      <CrewAgentIcons look={look} hostLabel={row.hostLabel} />
      <span className="min-w-0 truncate font-medium">{row.label}</span>
      {badge ? (
        <Badge variant="referenceLabel" className="shrink-0">
          {badge}
        </Badge>
      ) : null}
      {/* Only what waits on the user shows inline; the latest message is under the chevron. */}
      {preview.warning && !expanded ? (
        <span className="min-w-0 flex-1 truncate text-status-warning">{preview.text}</span>
      ) : null}
    </button>
  )
  return (
    <li className="group/crew-row min-w-0">
      <div className="flex h-6 min-w-0 items-center gap-2 text-foreground">
        {unavailable ? (
          <Tooltip>
            <TooltipTrigger asChild>{main}</TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {unavailable}
            </TooltipContent>
          </Tooltip>
        ) : (
          main
        )}
        <CrewStripRowEnd
          time={<CrewRowTime at={preview.at} className="font-mono text-3xs tabular-nums" />}
        >
          <IconButton
            label={t('components.orchestrationCrew.open', 'Open {{name}}', { name: row.label })}
            onClick={open}
          >
            <ExternalLink />
          </IconButton>
          {row.sendAddress ? (
            <IconButton
              label={t('components.orchestrationCrew.copyAddress', 'Copy address')}
              onClick={() => {
                const address = row.sendAddress
                if (address) {
                  void window.api.ui.writeTerminalClipboardText(address).then(() =>
                    toast.success(
                      t('components.orchestrationCrew.copiedAddress', "Copied {{name}}'s address", {
                        name: row.label
                      })
                    )
                  )
                }
              }}
            >
              <Copy />
            </IconButton>
          ) : null}
        </CrewStripRowEnd>
        <IconButton
          label={t('components.orchestrationCrew.showDetails', "Show {{name}}'s task and reply", {
            name: row.label
          })}
          aria-expanded={expanded}
          onClick={() => toggle(row.partyKey)}
        >
          <ChevronRight
            className={cn(
              'transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
        </IconButton>
      </div>
      {expanded ? (
        <div className="min-w-0 pb-1.5 pl-6 pt-1">
          <CrewRowDetails row={row} />
        </div>
      ) : null}
    </li>
  )
})

/** The row's time, swapped for its actions on hover or focus; rows of every kind share this column. */
export function CrewStripRowEnd({
  time,
  shown = false,
  children
}: {
  time: React.ReactNode
  /** Keep the actions out, as while one of their menus is open. */
  shown?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center justify-end">
      <span
        className={cn(
          'min-w-8 items-center justify-end text-muted-foreground group-focus-within/crew-row:hidden group-hover/crew-row:hidden',
          shown ? 'hidden' : 'flex'
        )}
      >
        {time}
      </span>
      <span
        className={cn(
          'items-center gap-0.5 group-focus-within/crew-row:flex group-hover/crew-row:flex',
          shown ? 'flex' : 'hidden'
        )}
      >
        {children}
      </span>
    </span>
  )
}
