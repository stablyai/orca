import { redactBotText } from '../bots/bot-text-scan'
import { isCommandToolName } from '../native-chat/tools/native-chat-tool-activity'
import { CONNECTOR_TURN_ACTIVITY_LIMITS } from './connector-turn-activity-contract'

// What a tool is doing, in words a thread's readers follow without knowing the tool. Keys are tool
// names lowercased with separators dropped (read_file, ReadFile and Read.File are one).
const TOOL_VERBS: Record<string, string> = {
  read: 'Reading',
  readfile: 'Reading',
  view: 'Reading',
  viewimage: 'Looking at',
  edit: 'Editing',
  multiedit: 'Editing',
  write: 'Writing',
  writefile: 'Writing',
  applypatch: 'Editing',
  strreplace: 'Editing',
  notebookedit: 'Editing',
  grep: 'Searching for',
  glob: 'Looking for',
  search: 'Searching for',
  ls: 'Listing',
  list: 'Listing',
  webfetch: 'Reading',
  websearch: 'Searching the web for',
  task: 'Handing off:',
  agent: 'Handing off:'
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

export const ACTIVITY_STEP_LEFT_OUT = 'Step left out: it looked like it held a secret'

/** A plan step's title as a thread shows it; the agent writes steps freely, so they are filtered as tool input is. */
export function connectorTurnActivityStepTitle(content: string): string {
  return clipActivityText(shareableText(content)) || ACTIVITY_STEP_LEFT_OUT
}

/**
 * The line a thread shows for the tool a bot's turn is inside ("Running pnpm test", "Reading
 * slack-edge.ts"), from the status row's tool name and input preview. An input that looks like it
 * holds a secret is left out, since the thread's readers are not the machine's owner.
 */
export function connectorTurnActivityLine(
  toolName: string | undefined,
  toolInput: string | undefined
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
    line = detail ? `Running ${detail}` : 'Running a command'
  } else if (PLAN_TOOLS.has(key)) {
    line = 'Updating the plan'
  } else if (key.startsWith('mcp')) {
    // mcp__server__tool: the server is what a reader knows.
    const [, server, tool] = name.split('__')
    line = server
      ? `Using ${server}${tool ? ` (${tool.replaceAll('_', ' ')})` : ''}`
      : 'Using a tool'
  } else {
    const verb = TOOL_VERBS[key]
    line = verb ? (detail ? `${verb} ${detail}` : `Using ${name}`) : `Using ${name}`
  }
  return clipActivityText(line)
}
