import { memo, type JSX } from 'react'
import { Bookmark, Check, UserRound } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { BotItemStatusIcon } from '@/components/bots/items/BotItemStatusIcon'
import { BOT_MASCOT_URLS } from '@/components/bots/bot-mascots'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { SlackIcon } from '@/components/icons/SlackIcon'
import { useTranslate } from '@/i18n/use-translate'
import { cueOn, SLACK_PAGE } from './bots-tip-timeline'
import { BotsTipScroll, on } from './bots-tip-pieces'

// Sample data drawn as Slack would print it: times, a duration and the repo, never translated.
const ASKED_AT = '9:41 AM'
const AGENTS_TOOK = '3m 12s'
const PR_SOURCE = 'GitHub · web-app'

function BotMessage({
  avatar,
  name,
  time,
  children
}: {
  avatar: string
  name: string
  time: string
  children: React.ReactNode
}): JSX.Element {
  const t = useTranslate()
  return (
    <div className="bt-sl-msg">
      <span className="bt-sl-av">
        <img src={avatar} alt="" />
      </span>
      <div>
        <div>
          <span className="bt-sl-name">{name}</span>
          <span className="bt-sl-tag">{t('featureTips.botsTeammate.slackAppTag', 'APP')}</span>
          <span className="bt-sl-time">{time}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Page 1: asked in a Slack thread, the bot runs agents, a reviewer bot checks, a pull request lands. */
// Memoized: a page off screen keeps its frame and skips the shown page's cue renders.
export const BotsTipSlackVisual = memo(function BotsTipSlackVisual({
  t: time
}: {
  t: number
}): JSX.Element {
  const t = useTranslate()
  const p = SLACK_PAGE
  const releaseBot = t('featureTips.botsTeammate.releaseBot', 'Release bot')
  const agents = [
    { agent: 'claude', name: t('featureTips.botsTeammate.taskDesktop', 'Desktop settings layout') },
    { agent: 'codex', name: t('featureTips.botsTeammate.taskMobile', 'Mobile settings screen') },
    { agent: 'claude', name: t('featureTips.botsTeammate.taskScreenshots', 'Screenshot tests') },
    { agent: 'codex', name: t('featureTips.botsTeammate.taskTypes', 'Type errors') }
  ] as const
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden p-6">
      <div className="bt-slack">
        <div className="bt-slack-head">
          <SlackIcon />
          {t('featureTips.botsTeammate.slackThread', 'Thread')}
          <small>{t('featureTips.botsTeammate.slackChannel', '# mobile')}</small>
        </div>
        <BotsTipScroll>
          <div className="bt-grow" {...on(cueOn(time, p.ask))}>
            <div>
              <div className="bt-sl-msg">
                <span className="bt-sl-av bt-person">
                  <UserRound />
                </span>
                <div>
                  <div>
                    <span className="bt-sl-name">
                      {t('featureTips.botsTeammate.slackPerson', 'Jordan Lee')}
                    </span>
                    <span className="bt-sl-time">{ASKED_AT}</span>
                  </div>
                  <div className="bt-sl-text">
                    <span className="bt-sl-mention">@{releaseBot}</span>{' '}
                    {t(
                      'featureTips.botsTeammate.slackAsk',
                      'the settings page breaks on mobile. Can you take it?'
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="bt-grow" {...on(cueOn(time, ...p.typing))}>
            <div>
              <div className="bt-sl-typing">
                <span className="bt-sl-dots">
                  <i />
                  <i />
                  <i />
                </span>
                {t('featureTips.botsTeammate.slackTyping', '{{name}} is typing', {
                  name: releaseBot
                })}
              </div>
            </div>
          </div>
          <div className="bt-grow" {...on(cueOn(time, p.reply))}>
            <div>
              <BotMessage avatar={BOT_MASCOT_URLS.A1} name={releaseBot} time="9:41 AM">
                <div className="bt-sl-text">
                  {t('featureTips.botsTeammate.slackReply', 'On it. Running 4 agents in parallel.')}
                </div>
                <div className="bt-sl-card">
                  <div className="bt-grow" {...on(!cueOn(time, p.agentsSummary))}>
                    <div>
                      {agents.map((row, index) => {
                        const done = time >= p.agentsDone[index]!
                        return (
                          <div key={row.name} className="bt-sl-agent">
                            <AgentIcon agent={row.agent} />
                            <span className="bt-sl-agent-name">{row.name}</span>
                            <span className="bt-sl-agent-state">
                              <BotItemStatusIcon status={done ? 'done' : 'working'} live />
                              {done
                                ? t('featureTips.botsTeammate.agentDone', 'Done')
                                : t('featureTips.botsTeammate.agentRunning', 'Running')}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div className="bt-grow" {...on(cueOn(time, p.agentsSummary))}>
                    <div>
                      <div className="bt-sl-agent">
                        <BotItemStatusIcon status="done" />
                        <span className="bt-sl-agent-name">
                          {t('featureTips.botsTeammate.agentsFinished', '4 agents finished')}
                        </span>
                        <span className="bt-sl-agent-state">{AGENTS_TOOK}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </BotMessage>
            </div>
          </div>
          <div className="bt-grow" {...on(cueOn(time, p.review))}>
            <div>
              <BotMessage
                avatar={BOT_MASCOT_URLS.E1}
                name={t('featureTips.botsTeammate.reviewBot', 'Review bot')}
                time="9:55 AM"
              >
                <div className="bt-sl-text">
                  {t(
                    'featureTips.botsTeammate.slackReview',
                    'Reviewed the diff. Fixed two spacing issues on small screens.'
                  )}
                </div>
              </BotMessage>
            </div>
          </div>
          <div className="bt-grow" {...on(cueOn(time, p.memory))}>
            <div>
              <BotMessage avatar={BOT_MASCOT_URLS.A1} name={releaseBot} time="9:56 AM">
                <div className="bt-sl-text">
                  {t(
                    'featureTips.botsTeammate.slackMemory',
                    'Noted for next time: check settings at the small breakpoint.'
                  )}
                </div>
                <span className="bt-sl-chip">
                  <Bookmark />
                  {t('featureTips.botsTeammate.savedToMemory', 'Saved to memory')}
                </span>
              </BotMessage>
            </div>
          </div>
          <div className="bt-grow" {...on(cueOn(time, p.pullRequest))}>
            <div>
              <BotMessage avatar={BOT_MASCOT_URLS.A1} name={releaseBot} time="9:58 AM">
                <div className="bt-sl-text">
                  {t('featureTips.botsTeammate.slackReady', 'Ready for review.')}
                </div>
                <div className="bt-sl-card">
                  <div className="bt-sl-pr">
                    <span className="bt-sl-pr-bar" />
                    <div>
                      <div className="bt-sl-pr-src">
                        <GitHubIcon />
                        {PR_SOURCE}
                      </div>
                      <div className="bt-sl-pr-title">
                        {t(
                          'featureTips.botsTeammate.slackPrTitle',
                          '#1284 Make the settings page responsive'
                        )}
                      </div>
                      <div className="bt-sl-pr-desc">
                        {t(
                          'featureTips.botsTeammate.slackPrBody',
                          'Desktop and mobile layouts, with updated screenshot tests.'
                        )}
                      </div>
                      <div className="bt-sl-pr-meta">
                        {t('featureTips.botsTeammate.slackPrFiles', '6 files')}
                        <span>
                          <span className="bt-sl-added">+132</span>{' '}
                          <span className="bt-sl-removed">−41</span>
                        </span>
                        <span className="bt-sl-ok">
                          <Check strokeWidth={2.4} />
                          {t('featureTips.botsTeammate.checksPassed', 'Checks passed')}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </BotMessage>
            </div>
          </div>
        </BotsTipScroll>
      </div>
    </div>
  )
})
