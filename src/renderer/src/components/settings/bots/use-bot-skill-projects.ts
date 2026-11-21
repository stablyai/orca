import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { callBotRpc, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import type {
  BotOwnSkillsView,
  BotSkillProjectView
} from '../../../../../shared/bots/bot-skill-projects'

/** The projects' skills as the bot's host reads them: its projects are that host's. */
export function scanBotSkillProjects(
  bot: BotOnHost,
  repoIds: readonly string[]
): Promise<BotSkillProjectView[]> {
  return callBotRpc<{ projects: BotSkillProjectView[] }>(bot, 'bots.skillProjects.scan', {
    repoIds
  }).then((answer) => answer.projects)
}

/** The projects' skills, read again whenever the list changes; null until the first read lands. */
export function useBotSkillProjects(
  bot: BotOnHost,
  repoIds: readonly string[],
  enabled = true
): Map<string, BotSkillProjectView> | null {
  const [views, setViews] = useState<Map<string, BotSkillProjectView> | null>(null)
  const key = repoIds.join('\n')
  const { hostId } = bot
  useEffect(() => {
    if (!enabled) {
      return
    }
    let current = true
    const ids = key ? key.split('\n') : []
    void scanBotSkillProjects({ hostId }, ids)
      .then((projects) => {
        if (current) {
          setViews(new Map(projects.map((project) => [project.repoId, project])))
        }
      })
      .catch(() => {
        if (current) {
          setViews(new Map())
        }
      })
    return () => {
      current = false
    }
  }, [key, enabled, hostId])
  return views
}

/** The bot's own skills as its host reads them, read again when its agent changes; undefined until
 *  the read lands, null from a host too old to send them. */
export function useBotOwnSkills(
  bot: BotRef & { agent: string }
): BotOwnSkillsView | null | undefined {
  const [own, setOwn] = useState<BotOwnSkillsView | null | undefined>(undefined)
  const { hostId, id, agent } = bot
  useEffect(() => {
    let current = true
    setOwn(undefined)
    void callBotRpc<{ own?: BotOwnSkillsView }>({ hostId }, 'bots.skillProjects.scan', {
      repoIds: [],
      botId: id
    })
      .then((answer) => answer.own ?? null)
      .catch(() => null)
      .then((read) => {
        if (current) {
          setOwn(read)
        }
      })
    return () => {
      current = false
    }
  }, [hostId, id, agent])
  return own
}

/** What a bot loads skills from, as a names line lists it: its own skills, when it has any, then its projects. */
export function botSkillSourceNames(
  own: BotOwnSkillsView | null | undefined,
  projectNames: readonly string[]
): string[] {
  const hasOwn = own ? own.skills.length + own.agentOnly.length > 0 : false
  return [
    ...(hasOwn ? [translate('settings.bots.skills.ownShort', 'Own skills')] : []),
    ...projectNames
  ]
}
