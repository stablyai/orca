import type { ToolSnapshot } from './listener-event'

const TOOL_INPUT_KEYS_BY_TOOL: Record<string, readonly string[]> = {
  Read: ['file_path', 'filePath', 'path'],
  Write: ['file_path', 'filePath', 'path'],
  Create: ['file_path', 'filePath', 'path'],
  Edit: ['file_path', 'filePath', 'path'],
  Execute: ['command'],
  MultiEdit: ['file_path', 'filePath', 'path'],
  NotebookEdit: ['file_path', 'filePath', 'path'],
  Bash: ['command'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  FetchUrl: ['url'],
  read_file: ['file_path', 'path'],
  write_file: ['file_path', 'path'],
  read_many_files: ['file_path', 'paths', 'path'],
  edit_file: ['file_path', 'path'],
  replace: ['file_path', 'path'],
  run_shell_command: ['command'],
  run_command: ['CommandLine', 'command', 'cmd'],
  glob: ['pattern'],
  search_file_content: ['pattern'],
  web_fetch: ['url'],
  google_web_search: ['query'],
  exec_command: ['cmd', 'command'],
  shell_command: ['cmd', 'command'],
  run_terminal_cmd: ['command'],
  // Why: Grok maps Bash/Edit/Write to snake_case tool names; without these keys the status row shows blank toolInput for most Grok turns.
  run_terminal_command: ['command'],
  search_replace: ['file_path', 'path', 'filePath'],
  write_to_file: ['TargetFile', 'path', 'file_path'],
  execute_code: ['code', 'command', 'cmd'],
  apply_patch: ['path', 'file_path'],
  view_image: ['path', 'file_path'],
  AskUser: ['question', 'prompt', 'message'],
  ask_user: ['question', 'prompt', 'message'],
  AskUserQuestion: ['questions', 'question', 'prompt', 'message'],
  ask_user_question: ['questions', 'question', 'prompt', 'message'],
  bash: ['command'],
  powershell: ['command'],
  create: ['path', 'file_path'],
  read: ['path', 'file_path'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  view: ['path', 'file_path'],
  grep: ['pattern'],
  web_search: ['query'],
  fetch_content: ['url'],
  terminal: ['command'],
  patch: ['path', 'file_path'],
  search_files: ['query', 'pattern', 'path'],
  browser_navigate: ['url'],
  browser_click: ['target', 'selector', 'text'],
  browser_type: ['text', 'target', 'selector'],
  session_search: ['query'],
  skill_manage: ['action', 'name', 'file_path'],
  delegate_task: ['task', 'prompt', 'description'],
  view_file: ['AbsolutePath', 'path', 'file_path'],
  replace_file_content: ['TargetFile', 'path', 'file_path'],
  multi_replace_file_content: ['TargetFile', 'path', 'file_path'],
  list_dir: ['DirectoryPath', 'path'],
  find_by_name: ['SearchDirectory', 'Pattern', 'query'],
  grep_search: ['SearchPath', 'Query', 'query', 'pattern'],
  search_web: ['query'],
  read_url_content: ['Url', 'url'],
  manage_task: ['TaskId', 'Action'],
  schedule: ['Prompt', 'DurationSeconds', 'CronExpression'],
  ask_question: ['question', 'questions'],
  ask_permission: ['Action', 'Target', 'Reason'],
  spawn_subagent: ['prompt', 'description', 'subagent_type'],
  open_page: ['url']
}

const FALLBACK_TOOL_INPUT_KEYS = [
  'command',
  'cmd',
  'code',
  'query',
  'pattern',
  'url',
  'path',
  'file_path',
  'filePath',
  'target',
  'selector',
  'text',
  'action',
  'name',
  'description',
  'CommandLine',
  'AbsolutePath',
  'TargetFile',
  'DirectoryPath',
  'SearchPath',
  'Query',
  'Url',
  'Prompt'
] as const

export function deriveToolInputPreview(
  toolName: string | undefined,
  toolInput: unknown
): string | undefined {
  if (typeof toolInput === 'string') {
    return toolInput
  }
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined
  }
  if (!toolName) {
    return undefined
  }
  const keys = TOOL_INPUT_KEYS_BY_TOOL[toolName]
  if (!keys) {
    return undefined
  }
  const record = toolInput as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

export function deriveFallbackToolInputPreview(toolInput: unknown): string | undefined {
  if (typeof toolInput === 'string') {
    return toolInput
  }
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined
  }
  const record = toolInput as Record<string, unknown>
  for (const key of FALLBACK_TOOL_INPUT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function hasOwnField(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key)
}

export function hasAnyOwnField(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => hasOwnField(record, key))
}

export function toolUpdate(
  fields: Pick<ToolSnapshot, 'toolName' | 'toolInput' | 'interactivePrompt'>,
  options?: { hasToolInputField?: boolean }
): ToolSnapshot {
  return {
    ...fields,
    hasToolUpdate: true,
    hasToolInputField: options?.hasToolInputField === true
  }
}
