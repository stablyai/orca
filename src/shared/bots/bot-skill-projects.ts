import type { BotAgentSkillsFolder } from './bot-package'

/** A linked project's skills as Settings shows them. */
export type BotSkillProjectView = {
  repoId: string
  name: string
  /** local: scanned on this computer; remote: on another host, which a bot can't load yet; missing: no longer a project. */
  status: 'local' | 'remote' | 'missing'
  /** The skills folder the bot loads; null when the project has none. */
  skillsDir: string | null
  skills: { name: string; description: string | null }[]
}

/** A bot's own skills as Settings shows them: skills/ in its home (every agent loads them), then any
 *  that only one agent's folder holds. */
export type BotOwnSkillsView = {
  /** What Open folder shows: skills/, or for an older bot with none there, the agent folder its skills are in. */
  skillsDir: string
  /** One per real folder (`folder` tells two skills of one name apart), with each agent folder that
   *  loads it: empty when something else holds both of its names, absent (unknown) from an earlier
   *  development build. */
  skills: {
    name: string
    description: string | null
    folder: string
    loadedBy?: BotAgentSkillsFolder[]
  }[]
  /** Skills kept in the agents' own folders, the same way. */
  agentOnly: {
    name: string
    description: string | null
    folder: string
    loadedBy: BotAgentSkillsFolder[]
  }[]
}

/** Agents that skip the linked skill folders Orca loads project skills from, so their bots get a list instead. */
export const BOT_AGENTS_LISTING_LINKED_SKILLS: readonly string[] = [
  'grok',
  'antigravity',
  'cursor',
  'hermes',
  'kimi',
  'kiro',
  'goose',
  'kilo',
  'mimo-code',
  'gemini',
  'droid'
]
