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

/** Agents that skip the linked skill folders Orca loads project skills from, so their bots get a list instead. */
export const BOT_AGENTS_LISTING_LINKED_SKILLS: readonly string[] = [
  'grok',
  'antigravity',
  'cursor',
  'hermes'
]
