import { useEffect, useState } from 'react'
import { callBotRpc, type BotOnHost } from '@/lib/bot-hosts'
import type { BotSkillProjectView } from '../../../../../shared/bots/bot-skill-projects'

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
