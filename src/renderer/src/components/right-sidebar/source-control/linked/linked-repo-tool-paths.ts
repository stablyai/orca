// Tools whose input path means the agent changed that file.
const FILE_WRITE_TOOL_NAMES = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'Create',
  'NotebookEdit',
  'write_file',
  'edit_file',
  'replace',
  'search_replace',
  'write_to_file',
  'apply_patch',
  'replace_file_content',
  'multi_replace_file_content',
  'create',
  'write',
  'edit',
  'patch'
])

// Shell tools whose command text is the tool input preview.
const SHELL_TOOL_NAMES = new Set([
  'Bash',
  'Execute',
  'run_shell_command',
  'run_command',
  'exec_command',
  'shell_command',
  'run_terminal_cmd',
  'run_terminal_command',
  'bash',
  'powershell',
  'terminal'
])

const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm
const QUOTED_OR_BARE = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s;&|()<>"']+))`
const DIRECTORY_CHANGE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:cd|pushd|Set-Location|sl|chdir)\s+(?:-\w+\s+)*${QUOTED_OR_BARE}`,
  'gi'
)
const GIT_DIRECTORY = new RegExp(String.raw`\bgit\s+-C\s+${QUOTED_OR_BARE}`, 'g')
// Windows drive paths, or POSIX paths at a token start (so `a/b` and URLs are skipped).
const ABSOLUTE_PATH =
  /"([A-Za-z]:[\\/][^"]*|\/[^"]+)"|'([A-Za-z]:[\\/][^']*|\/[^']+)'|(?:^|[\s=>])([A-Za-z]:[\\/][^\s;&|()<>"']*|\/[^\s;&|()<>"']+)/g

export type ToolPathUse = {
  path: string
  /** Edit tools certainly changed the path; shell paths need a Git status check first. */
  certainWrite: boolean
}

function firstGroup(match: RegExpMatchArray): string | undefined {
  return match.slice(1).find(Boolean)?.trim()
}

/** Paths a shell command points at: cd/pushd/git -C directories and absolute arguments. */
export function extractShellCommandPaths(command: string): string[] {
  const paths = new Set<string>()
  for (const pattern of [DIRECTORY_CHANGE, GIT_DIRECTORY, ABSOLUTE_PATH]) {
    for (const match of command.matchAll(pattern)) {
      const path = firstGroup(match)
      if (path && !path.startsWith('$') && !path.startsWith('~') && !path.startsWith('/dev/')) {
        paths.add(path)
      }
    }
  }
  return [...paths]
}

/** File paths an edit tool touched: its path argument, or each file header of a patch body. */
export function extractEditToolPaths(toolInput: string): string[] {
  if (toolInput.includes('*** Begin Patch')) {
    return [...toolInput.matchAll(PATCH_FILE_HEADER)].map((match) => match[1].trim())
  }
  const trimmed = toolInput.trim()
  return trimmed && !trimmed.includes('\n') ? [trimmed] : []
}

/** Paths a tool call may have changed; reads and searches yield nothing. */
export function extractToolPathUses(
  toolName: string | undefined,
  toolInput: string | undefined
): ToolPathUse[] {
  if (!toolName || !toolInput) {
    return []
  }
  if (FILE_WRITE_TOOL_NAMES.has(toolName)) {
    return extractEditToolPaths(toolInput).map((path) => ({ path, certainWrite: true }))
  }
  if (SHELL_TOOL_NAMES.has(toolName)) {
    return extractShellCommandPaths(toolInput).map((path) => ({ path, certainWrite: false }))
  }
  return []
}
