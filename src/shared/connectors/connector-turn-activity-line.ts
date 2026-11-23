import { redactBotText } from '../bots/bot-text-scan'
import { englishTranslate, type CopyTranslate } from '../i18n/english-translate'
import { isCommandToolName } from '../native-chat/tools/native-chat-tool-activity'
import { CONNECTOR_TURN_ACTIVITY_LIMITS } from './connector-turn-activity-contract'

// The thread's words, keyed under bots.threadActivity; each holds its slot so a language can move it.
export const CONNECTOR_TURN_ACTIVITY_COPY = {
  reading: 'Reading {{detail}}',
  lookingAt: 'Looking at {{detail}}',
  editing: 'Editing {{detail}}',
  writing: 'Writing {{detail}}',
  searchingFor: 'Searching for {{detail}}',
  lookingFor: 'Looking for {{detail}}',
  listing: 'Listing {{detail}}',
  searchingWeb: 'Searching the web for {{detail}}',
  handingOff: 'Handing off: {{detail}}',
  running: 'Running {{detail}}',
  runningCommand: 'Running a command',
  updatingPlan: 'Updating the plan',
  usingServerTool: 'Using {{server}} ({{tool}})',
  usingServer: 'Using {{server}}',
  usingTool: 'Using a tool',
  usingNamed: 'Using {{name}}',
  stepLeftOut: 'Step left out: it looked like it held a secret'
} as const

type ActivityCopyCode = keyof typeof CONNECTOR_TURN_ACTIVITY_COPY

const say = (
  translate: CopyTranslate,
  code: ActivityCopyCode,
  values?: Record<string, string>
): string => translate(`bots.threadActivity.${code}`, CONNECTOR_TURN_ACTIVITY_COPY[code], values)

// What a tool is doing, in words a thread's readers follow without knowing the tool. Keys are tool
// names lowercased with separators dropped (read_file, ReadFile and Read.File are one).
const TOOL_VERBS: Record<string, ActivityCopyCode> = {
  read: 'reading',
  readfile: 'reading',
  view: 'reading',
  viewimage: 'lookingAt',
  edit: 'editing',
  multiedit: 'editing',
  write: 'writing',
  writefile: 'writing',
  applypatch: 'editing',
  strreplace: 'editing',
  notebookedit: 'editing',
  grep: 'searchingFor',
  glob: 'lookingFor',
  search: 'searchingFor',
  ls: 'listing',
  list: 'listing',
  webfetch: 'reading',
  websearch: 'searchingWeb',
  task: 'handingOff',
  agent: 'handingOff'
}

const PLAN_TOOLS = new Set(['todowrite', 'updateplan'])

const toolKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** One line within the activity text limit. */
export function clipActivityText(text: string): string {
  const max = CONNECTOR_TURN_ACTIVITY_LIMITS.maxActivityTextChars
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** Text a thread's readers may see: URL queries dropped, nothing when it looks like it holds a secret. */
function shareableText(text: string): string {
  const { text: shown, leftOut } = redactBotText(text)
  return leftOut === 0 ? shown : ''
}

/** A plan step's title as a thread shows it; the agent writes steps freely, so they are filtered as tool input is. */
export function connectorTurnActivityStepTitle(
  content: string,
  translate: CopyTranslate = englishTranslate
): string {
  return clipActivityText(shareableText(content)) || say(translate, 'stepLeftOut')
}

/**
 * The line a thread shows for the tool a bot's turn is inside ("Running pnpm test", "Reading
 * slack-edge.ts"), from the status row's tool name and input preview. An input that looks like it
 * holds a secret is left out, since the thread's readers are not the machine's owner. Worded by
 * `translate` (the host's UI language); English without one.
 */
export function connectorTurnActivityLine(
  toolName: string | undefined,
  toolInput: string | undefined,
  translate: CopyTranslate = englishTranslate
): string | undefined {
  const name = toolName?.trim()
  if (!name) {
    return undefined
  }
  const input = (toolInput ?? '').split('\n')[0]!.trim()
  const detail = shareableText(input)
  const key = toolKey(name)
  let line: string
  if (isCommandToolName(name)) {
    line = detail ? say(translate, 'running', { detail }) : say(translate, 'runningCommand')
  } else if (PLAN_TOOLS.has(key)) {
    line = say(translate, 'updatingPlan')
  } else if (key.startsWith('mcp')) {
    // mcp__server__tool: the server is what a reader knows.
    const [, server, tool] = name.split('__')
    line = !server
      ? say(translate, 'usingTool')
      : tool
        ? say(translate, 'usingServerTool', { server, tool: tool.replaceAll('_', ' ') })
        : say(translate, 'usingServer', { server })
  } else {
    const verb = TOOL_VERBS[key]
    line =
      verb && detail ? say(translate, verb, { detail }) : say(translate, 'usingNamed', { name })
  }
  return clipActivityText(line)
}
