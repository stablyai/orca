import { formatAgentImagePath } from './agent-image-paste'
import { formatImageDropPasteText, isTerminalDropWindowsPathLike } from './image-path-paste'

/** Escape image paths as terminal drops do; agent TUIs unescape before checking file existence. */
export function agentImagePastePath(agent: string | null | undefined, path: string): string {
  const formatted = formatAgentImagePath(agent, path)
  if (formatted !== path) {
    return formatted
  }
  const targetShell = isTerminalDropWindowsPathLike(path) ? 'windows' : 'posix'
  return formatImageDropPasteText(path, targetShell) ?? path
}
