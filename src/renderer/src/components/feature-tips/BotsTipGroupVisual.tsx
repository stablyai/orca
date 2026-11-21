import { memo, type JSX, type ReactNode } from 'react'
import { GitPullRequest, Plus, Square } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { BOT_MASCOT_URLS } from '@/components/bots/bot-mascots'
import { BotGroupPeerRequestLine } from '@/components/bots/BotGroupPeerRequestLine'
import { NativeChatEventRow } from '@/components/native-chat/messages/events/NativeChatEventRow'
import { NativeChatUserBubble } from '@/components/native-chat/messages/rows/NativeChatUserBubble'
import { useTranslate } from '@/i18n/use-translate'
import type { BotGroupMessage } from '../../../../shared/bots/bot-group'
import { cueOn, GROUP_PAGE } from './bots-tip-timeline'
import { BotsTipScroll, on } from './bots-tip-pieces'
import { BotsTipWindowTabs } from './BotsTipWindowTabs'

// The chat's mention token and a worker's branch-style name, never translated.
const MENTION_ALL = '@everyone'
const WORKER_NAME = 'settings-page'

function Turn({
  shown,
  avatar,
  name,
  children
}: {
  shown: boolean
  avatar: string
  name: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="bt-grow" {...on(shown)}>
      <div>
        <div className="bt-turn">
          <img src={avatar} alt="" />
          <div className="bt-turn-body">
            <b>{name}</b>
            <div className="bt-turn-lines">{children}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The hand-off as the group chat records it: the release bot's request to the reviewer. */
function handOff(from: string, to: string): BotGroupMessage {
  return {
    id: 'hand-off',
    groupId: 'launch-crew',
    sequence: 2,
    author: { kind: 'bot', id: 'release', name: to },
    text: '',
    createdAt: 0,
    requester: { id: 'release', name: from },
    turns: []
  }
}

/** Page 3: a group chat of bots split one goal and come back with one answer. */
// Memoized: a page off screen keeps its frame and skips the shown page's cue renders.
export const BotsTipGroupVisual = memo(function BotsTipGroupVisual({
  t: time
}: {
  t: number
}): JSX.Element {
  const t = useTranslate()
  const p = GROUP_PAGE
  const group = t('featureTips.botsTeammate.groupName', 'Launch crew')
  const release = t('featureTips.botsTeammate.releaseBot', 'Release bot')
  const review = t('featureTips.botsTeammate.reviewBot', 'Review bot')
  const faces = [BOT_MASCOT_URLS.A1, BOT_MASCOT_URLS.E1, BOT_MASCOT_URLS.B1]
  return (
    <div className="bt-stage">
      <div className="bt-cam" data-state="group">
        <div className="bt-win bt-win-group dark">
          <div className="bt-center">
            <BotsTipWindowTabs>
              <span className="bt-tab-faces">
                {faces.map((src) => (
                  <img key={src} src={src} alt="" />
                ))}
              </span>
              <span>{group}</span>
            </BotsTipWindowTabs>
            <div className="bt-chat bt-group-chat">
              <BotsTipScroll>
                <div className="bt-grow" {...on(cueOn(time, p.ask))}>
                  <div>
                    <NativeChatUserBubble className="bt-you">
                      <span className="bt-mention">{MENTION_ALL}</span>{' '}
                      {t('featureTips.botsTeammate.groupAsk', 'Ship the new settings page.')}
                    </NativeChatUserBubble>
                  </div>
                </div>
                <Turn
                  shown={cueOn(time, p.releaseStarts)}
                  avatar={BOT_MASCOT_URLS.A1}
                  name={release}
                >
                  {t('featureTips.botsTeammate.groupBuilding', 'Building it.')}
                  <NativeChatEventRow
                    className="mt-0.5"
                    icon={<AgentIcon agent="claude" size={14} />}
                    badge={time >= p.workerDone ? null : 'running'}
                  >
                    {t('components.native-chat.agentMessage.row.started', 'Started')}{' '}
                    <span className="text-chat-foreground">{WORKER_NAME}</span>
                  </NativeChatEventRow>
                </Turn>
                <div className="bt-grow" {...on(cueOn(time, p.handOff))}>
                  <div>
                    <BotGroupPeerRequestLine message={handOff(release, review)} />
                  </div>
                </div>
                <Turn shown={cueOn(time, p.review)} avatar={BOT_MASCOT_URLS.E1} name={review}>
                  {t(
                    'featureTips.botsTeammate.groupReview',
                    'The save button overlaps the footer on small screens.'
                  )}
                </Turn>
                <Turn
                  shown={cueOn(time, p.docs)}
                  avatar={BOT_MASCOT_URLS.B1}
                  name={t('featureTips.botsTeammate.docsBot', 'Docs bot')}
                >
                  {t('featureTips.botsTeammate.groupDocs', 'Updated the settings docs.')}
                </Turn>
                <Turn shown={cueOn(time, p.answer)} avatar={BOT_MASCOT_URLS.A1} name={release}>
                  {t('featureTips.botsTeammate.groupAnswer', 'Fixed the overlap. Ready for you:')}
                  <span className="bt-pr-link">
                    <GitPullRequest className="size-3" />
                    <span>{t('featureTips.botsTeammate.groupPr', '#1302 New settings page')}</span>
                  </span>
                </Turn>
              </BotsTipScroll>
              <div className="bt-composer">
                <div className="bt-composer-ph">
                  {t(
                    'featureTips.botsTeammate.groupComposer',
                    'Message {{group}}, @ to mention a bot',
                    { group }
                  )}
                </div>
                <div className="bt-composer-row">
                  <Plus className="size-3.5" />
                  <span className="bt-send">
                    <Square className="size-2.5 fill-current" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})
