const TOOL_LABELS: Readonly<Record<string, string>> = {
  applypatch: 'Edit files',
  agent: 'Spawn subagent',
  askuserquestion: 'Ask user',
  automationupdate: 'Manage automation',
  bash: 'Run command',
  closeagent: 'Stop subagent',
  command: 'Run command',
  computer: 'Control computer',
  createfolder: 'Create folder',
  creategoal: 'Create goal',
  createthread: 'Start task',
  croncreate: 'Create automation',
  crondelete: 'Delete automation',
  edit: 'Edit file',
  enterplanmode: 'Enter plan mode',
  execcommand: 'Run command',
  exitplanmode: 'Exit plan mode',
  find: 'Find files',
  followuptask: 'Continue subagent',
  forkthread: 'Fork task',
  forwardmessage: 'Message subagent',
  forwardmessages: 'Message subagent',
  getgoal: 'Read goal',
  glob: 'Find files',
  grep: 'Search code',
  imagegen: 'Generate image',
  imagequery: 'Search images',
  interruptagent: 'Stop subagent',
  listagents: 'List subagents',
  listmcpresources: 'List resources',
  listmcpresourcetemplates: 'List resource templates',
  listthreads: 'List tasks',
  loadworkspacedependencies: 'Load workspace dependencies',
  localcommand: 'Run command',
  localshell: 'Run command',
  localshellcall: 'Run command',
  lsp: 'Inspect code',
  multiedit: 'Edit files',
  navigatetocodexpage: 'Open task',
  notebookedit: 'Edit notebook',
  read: 'Read file',
  readfile: 'Read file',
  readmcpresource: 'Read resource',
  readthread: 'Read task',
  readthreadterminal: 'Read task terminal',
  requestplugininstall: 'Install plugin',
  requestuserinput: 'Ask user',
  search: 'Search code',
  searchcode: 'Search code',
  searchquery: 'Search the web',
  sendmessage: 'Message subagent',
  sendmessagetothread: 'Message task',
  setthreadarchived: 'Archive task',
  setthreadpinned: 'Pin task',
  setthreadtitle: 'Rename task',
  shell: 'Run command',
  skill: 'Load skill',
  spawnagent: 'Spawn subagent',
  subagentactivity: 'Subagent activity',
  resumeagent: 'Resume subagent',
  task: 'Spawn subagent',
  taskcreate: 'Create task',
  taskoutput: 'Read task output',
  taskstop: 'Stop task',
  taskupdate: 'Update task',
  todowrite: 'Update plan',
  updategoal: 'Update goal',
  updateplan: 'Update plan',
  viewimage: 'View image',
  waitagent: 'Wait for subagent',
  waitthreads: 'Wait for task',
  webfetch: 'Open web page',
  webrun: 'Search the web',
  websearch: 'Search the web',
  workflow: 'Run workflow',
  write: 'Write file',
  writestdin: 'Send terminal input'
}

const NAMESPACE_PREFIXES = ['collaboration', 'codexapp', 'imagegen'] as const

export function canonicalNativeChatToolName(toolName: string | undefined): string {
  let name = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() ?? ''
  for (const prefix of NAMESPACE_PREFIXES) {
    const candidate = name.startsWith(prefix) ? name.slice(prefix.length) : ''
    if (candidate && TOOL_LABELS[candidate]) {
      name = candidate
      break
    }
  }
  return name
}

export function nativeChatToolLabel(toolName: string): string {
  // Codex qualifies MCP tools with their server; keep distinct tools distinguishable.
  if (toolName.includes('/')) {
    return toolName
  }
  const canonical = canonicalNativeChatToolName(toolName)
  const known = TOOL_LABELS[canonical]
  if (known) {
    return known
  }
  const leaf = toolName.split(/__|[.:/]/u).findLast(Boolean) ?? toolName
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : 'Use tool'
}

export function isSubagentToolName(toolName: string): boolean {
  return SUBAGENT_TOOLS.has(canonicalNativeChatToolName(toolName))
}

const SUBAGENT_TOOLS = new Set([
  'followuptask',
  'agent',
  'closeagent',
  'forwardmessage',
  'forwardmessages',
  'interruptagent',
  'listagents',
  'sendmessage',
  'spawnagent',
  'subagentactivity',
  'resumeagent',
  'task',
  'waitagent'
])
