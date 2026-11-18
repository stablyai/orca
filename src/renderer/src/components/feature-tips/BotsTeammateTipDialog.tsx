import { useRef, type JSX, type ReactElement } from 'react'
import { Trans } from 'react-i18next'
import type { FeatureTip } from '../../../../shared/feature-education/feature-tips'
import { BOT_AGENTS } from '../../../../shared/bot-types'
import { ACCOUNT_CONNECTORS, useBotConnectorAvailable } from '@/components/bots/bot-connectors'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { i18n, translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { BotsTeammateFeatureTipVisual } from './BotsTeammateFeatureTipVisual'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FEATURE_TIP_BUTTONS_ON_CARD_EDGE,
  FeatureTipDialogFrame,
  FeatureTipEyebrow
} from './FeatureTipDialogFrame'
import { FeatureTipRotatingSlot, type FeatureTipRotatingSlotItem } from './FeatureTipRotatingSlot'

/** "Slack, Linear or GitHub": the spec's list, without a comma before "or". */
function orList(labels: readonly string[]): string {
  return labels.length < 2
    ? (labels[0] ?? '')
    : translate('featureTips.botsTeammate.orList', '{{items}} or {{last}}', {
        items: labels.slice(0, -1).join(', '),
        last: labels.at(-1)
      })
}

function agentItems(): FeatureTipRotatingSlotItem[] {
  return BOT_AGENTS.map((agent) => ({
    key: agent,
    label: botAgentLabel(agent),
    icon: <AgentIcon agent={agent} size={16} />
  }))
}

const BOLD = <span className="font-semibold text-foreground" />

/** One translated line: `<b>` marks its lead, `<slot/>` holds a rotating slot. */
function TipLine({ text, slot }: { text: string; slot?: ReactElement }): JSX.Element {
  return <Trans i18n={i18n} defaults={text} components={slot ? { b: BOLD, slot } : { b: BOLD }} />
}

export function BotsTeammateTipDialog({
  open,
  tip,
  onOpenChange,
  onPrimaryAction,
  onSkip
}: {
  open: boolean
  tip: FeatureTip
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSkip: () => void
}): JSX.Element {
  const t = useTranslate()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  // Only the connectors this computer's Orca Cloud can link, as the Connectors settings offer them.
  const connectorAvailable = useBotConnectorAvailable()
  const connectorItems: FeatureTipRotatingSlotItem[] = ACCOUNT_CONNECTORS.filter(
    connectorAvailable
  ).map(({ id, label, Icon }) => ({ key: id, label, icon: <Icon className="size-4" /> }))

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: longer locales overflow the fixed frame; scrolling to the button would hide the title.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      visual={<BotsTeammateFeatureTipVisual />}
      copyClassName={FEATURE_TIP_BUTTONS_ON_CARD_EDGE}
    >
      <DialogHeader className="text-left">
        <div>
          <FeatureTipEyebrow label={t('featureTips.eyebrowNew', 'New')} />
          <DialogTitle size="display">
            {t('featureTips.botsTeammate.title', 'Your AI teammate')}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl">
            <span className="block leading-relaxed">
              {t(
                'featureTips.botsTeammate.description',
                'It works where your team works, takes on tasks from anyone, and sees them through. It remembers everything you teach it.'
              )}
            </span>
          </DialogDescription>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm leading-5 text-muted-foreground">
            <li>
              <TipLine
                text={t(
                  'featureTips.botsTeammate.alwaysOn',
                  '<b>Always on.</b> Works while you’re away.'
                )}
              />
            </li>
            <li>
              <TipLine
                text={t(
                  'featureTips.botsTeammate.partOfTeam',
                  '<b>Part of the team.</b> Anyone can ask it in <slot/>.'
                )}
                slot={
                  <FeatureTipRotatingSlot
                    items={connectorItems}
                    staticLabel={orList(connectorItems.map((item) => item.label))}
                  />
                }
              />
            </li>
            <li>
              <TipLine
                text={t(
                  'featureTips.botsTeammate.learns',
                  '<b>Learns as it goes.</b> Suggests what’s next.'
                )}
              />
            </li>
          </ul>
          <p className="mt-3 text-sm leading-5 text-foreground">
            <TipLine
              text={t('featureTips.botsTeammate.runsOn', 'Runs on any computer with <slot/>')}
              slot={
                <FeatureTipRotatingSlot
                  items={agentItems()}
                  // Short, so the static line never wraps the column into a scroll.
                  staticLabel={t('featureTips.botsTeammate.agentsStatic', 'Claude Code and more')}
                />
              }
            />
          </p>
        </div>
      </DialogHeader>

      {/* The static lists wrap the connector line; a tighter gap keeps the column from scrolling. */}
      <DialogFooter className="mt-8 flex motion-reduce:mt-6 sm:justify-stretch">
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={false}
          onPrimaryAction={onPrimaryAction}
          onSkip={onSkip}
          fullWidth
          primaryButtonRef={primaryButtonRef}
          secondaryLabel={t('featureTips.botsTeammate.later', 'Maybe later')}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}
