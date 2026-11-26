// The words for what a new bot finds as it first looks around, in each client's language.
import type { FirstLookRow } from './bot-first-look'
import type { BotChatTranslate } from './bot-chat-tree'

/** Shown by name; more are counted. */
const NAMES_SHOWN = 3

function namesText(names: readonly string[], t: BotChatTranslate): string {
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return names.length > NAMES_SHOWN
    ? t('bots.firstScreen.namesMore', '{{names}} and {{count}} more', {
        names: shown,
        count: names.length - NAMES_SHOWN
      })
    : shown
}

function projectsText(row: FirstLookRow, t: BotChatTranslate): string {
  if (row.state !== 'done') {
    return t('bots.firstScreen.projectsReading', 'Projects: looking at what you have in Orca…')
  }
  if (row.count === undefined) {
    return t('bots.firstScreen.projectsDone', 'Looked at your projects')
  }
  if (row.count === 0) {
    return t('bots.firstScreen.projectsNone', 'No projects in Orca yet')
  }
  const names = namesText(row.names ?? [], t)
  return row.count === 1
    ? t('bots.firstScreen.projectsOne', 'Found 1 project: {{names}}', {
        names
      })
    : t('bots.firstScreen.projectsMany', 'Found {{count}} projects: {{names}}', {
        count: row.count,
        names
      })
}

function githubText(row: FirstLookRow, t: BotChatTranslate): string {
  if (row.state !== 'done') {
    return t('bots.firstScreen.githubReading', 'GitHub: reading your open PRs…')
  }
  if (row.count === undefined) {
    return t('bots.firstScreen.githubDone', 'GitHub: looked at your work')
  }
  return row.count === 1
    ? t('bots.firstScreen.githubOne', 'GitHub: 1 open PR of yours')
    : t('bots.firstScreen.githubMany', 'GitHub: {{count}} open PRs of yours', {
        count: row.count
      })
}

function linearText(row: FirstLookRow, t: BotChatTranslate): string {
  if (row.state !== 'done') {
    return t('bots.firstScreen.linearReading', 'Linear: reading your open issues…')
  }
  if (row.count === undefined) {
    return t('bots.firstScreen.linearDone', 'Linear: looked at your issues')
  }
  if (row.more) {
    return t('bots.firstScreen.linearMore', 'Linear: {{count}}+ open issues assigned to you', {
      count: row.count
    })
  }
  return row.count === 1
    ? t('bots.firstScreen.linearOne', 'Linear: 1 open issue assigned to you')
    : t('bots.firstScreen.linearMany', 'Linear: {{count}} open issues assigned to you', {
        count: row.count
      })
}

function workspacesText(row: FirstLookRow, t: BotChatTranslate): string {
  if (row.state !== 'done') {
    return t(
      'bots.firstScreen.workspacesReading',
      'Workspaces: looking at what your agents are doing…'
    )
  }
  if (row.count === undefined) {
    return t('bots.firstScreen.workspacesDone', 'Looked at your workspaces')
  }
  if (row.count === 0) {
    return t('bots.firstScreen.workspacesNone', 'No workspaces with an agent open')
  }
  return row.count === 1
    ? t('bots.firstScreen.workspacesOne', 'Workspaces: 1 with an agent open')
    : t('bots.firstScreen.workspacesMany', 'Workspaces: {{count}} with an agent open', {
        count: row.count
      })
}

function toolsText(row: FirstLookRow, t: BotChatTranslate): string {
  if (row.state !== 'done') {
    return t('bots.firstScreen.toolsReading', 'Your tools: MCP servers…')
  }
  if (row.count === undefined) {
    return t('bots.firstScreen.toolsDone', 'Looked at your MCP servers')
  }
  if (row.count === 0) {
    return t('bots.firstScreen.toolsNone', 'No MCP servers yet')
  }
  const names = namesText(row.names ?? [], t)
  return row.count === 1
    ? t('bots.firstScreen.toolsOne', '1 MCP server: {{names}}', {
        names
      })
    : t('bots.firstScreen.toolsMany', '{{count}} MCP servers: {{names}}', {
        count: row.count,
        names
      })
}

const ROW_TEXT = {
  projects: projectsText,
  github: githubText,
  linear: linearText,
  workspaces: workspacesText,
  tools: toolsText
}

/** A first-look row's line in the reader's language, from what the bot found so far. */
export function firstLookRowText(row: FirstLookRow, t: BotChatTranslate): string {
  return ROW_TEXT[row.area](row, t)
}
