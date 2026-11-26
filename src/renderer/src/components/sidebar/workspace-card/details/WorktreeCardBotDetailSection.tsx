import React from 'react'
import type { Bot } from '../../../../../../shared/bot-types'
import { BotAvatar } from '@/components/bots/BotAvatar'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader } from '../metadata/WorktreeCardMetadataControls'
import { useTranslate } from '@/i18n/use-translate'
import type { CliWorkspaceProvenance } from '../../../../../../shared/worktree/types'
import { WorktreeCardCliDetailSection } from './WorktreeCardCliDetailSection'

export function WorktreeCardBotDetailSection({
  bot
}: {
  bot: Pick<Bot, 'id' | 'name' | 'avatar' | 'hostId'>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<BotAvatar bot={bot} className="size-3 rounded-sm border-0 text-[8px]" />}
        label={t('bots.workspaces.botHeader', 'Bot')}
      />
      <WorktreeCardDetailSectionContent>
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {t('bots.workspaces.madeBy', 'Made by {{name}}', { name: bot.name })}
        </div>
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}

/** Who made the workspace: its bot, then the CLI that created it. */
export function WorktreeCardOriginDetailSections({
  bot,
  cliProvenance
}: {
  bot?: Pick<Bot, 'id' | 'name' | 'avatar' | 'hostId'> | null
  cliProvenance?: CliWorkspaceProvenance | null
}): React.JSX.Element {
  return (
    <>
      {bot && <WorktreeCardBotDetailSection bot={bot} />}
      {cliProvenance && <WorktreeCardCliDetailSection provenance={cliProvenance} />}
    </>
  )
}
