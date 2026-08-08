import type { RoomActivityKind } from './rooms'

export function roomActivityKindFromTool(
  toolName: string | undefined,
  input?: unknown
): RoomActivityKind {
  if (
    typeof input === 'string' &&
    (input.includes('*** Begin Patch') || input.includes('tools.apply_patch'))
  ) {
    return 'editing'
  }
  const name = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() ?? ''
  if (READ_TOOLS.has(name)) {
    return 'reading'
  }
  if (SEARCH_TOOLS.has(name)) {
    return 'searching'
  }
  if (EDIT_TOOLS.has(name)) {
    return 'editing'
  }
  if (WEB_TOOLS.has(name)) {
    return 'web'
  }
  if (COMMAND_TOOLS.has(name)) {
    return 'command'
  }
  return 'working'
}

const READ_TOOLS = new Set(['read', 'readfile'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'find', 'search', 'searchcode'])
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'applypatch', 'notebookedit'])
const WEB_TOOLS = new Set(['websearch', 'webfetch', 'searchquery', 'imagequery'])
const COMMAND_TOOLS = new Set([
  'bash',
  'shell',
  'command',
  'execcommand',
  'localcommand',
  'localshell',
  'localshellcall'
])
