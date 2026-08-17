import type { Project } from './project-types'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'

function sessionHash(value: string): string {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Resolves the stock herdr session for a project.
 *
 * Priority: an explicit per-project override wins; otherwise the shared Orca
 * default (`sharedName`, typically `orca`) is used so every project reconciles
 * into one session; otherwise a stable per-project name is derived.
 */
export function herdrSessionNameForProject(
  project: Pick<Project, 'id' | 'herdrSessionName'>,
  sharedName?: string
): string {
  if (project.herdrSessionName?.trim()) {
    return project.herdrSessionName.trim()
  }
  if (sharedName?.trim()) {
    return sharedName.trim()
  }
  return `orca-${sessionHash(project.id)}`
}

export function firstTerminalLeafId(root: TerminalPaneLayoutNode | null): string | null {
  if (!root) {
    return null
  }
  return root.type === 'leaf' ? root.leafId : firstTerminalLeafId(root.first)
}

export function herdrSplitDirection(direction: 'vertical' | 'horizontal'): 'right' | 'down' {
  return direction === 'vertical' ? 'right' : 'down'
}
