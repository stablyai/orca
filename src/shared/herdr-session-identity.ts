import type { Project, TerminalPaneLayoutNode, Worktree } from './types'

export type HerdrExternalRef = { owner: 'orca'; id: string }

function normalizeSessionSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'project'
}

export function herdrSessionNameForProject(
  project: Pick<Project, 'id' | 'herdrSessionName'>
): string {
  if (project.herdrSessionName?.trim()) {
    return project.herdrSessionName.trim()
  }
  return `orca-${normalizeSessionSegment(project.id)}`.slice(0, 64)
}

export function herdrWorktreeRef(
  projectId: string,
  worktree: Pick<Worktree, 'id' | 'instanceId'>
): HerdrExternalRef {
  return { owner: 'orca', id: `${projectId}:worktree:${worktree.instanceId ?? worktree.id}` }
}

export function herdrTabRef(projectId: string, tabId: string): HerdrExternalRef {
  return { owner: 'orca', id: `${projectId}:tab:${tabId}` }
}

export function herdrPaneRef(projectId: string, leafId: string): HerdrExternalRef {
  return { owner: 'orca', id: `${projectId}:pane:${leafId}` }
}

export function firstTerminalLeafId(root: TerminalPaneLayoutNode | null): string | null {
  if (!root) return null
  return root.type === 'leaf' ? root.leafId : firstTerminalLeafId(root.first)
}

export function herdrSplitDirection(direction: 'vertical' | 'horizontal'): 'right' | 'down' {
  return direction === 'vertical' ? 'right' : 'down'
}
