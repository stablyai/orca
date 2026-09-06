import { isSmartWorkspaceSourceQueryWithinLimit } from './new-workspace/smart-workspace-source-query'
import type { KaneoTaskLink } from './kaneo-types'

const TASK_PATH = /^\/dashboard\/workspace\/([\w-]+)\/project\/([\w-]+)\/task\/([\w-]+)\/?$/

export function normalizeKaneoSiteUrl(input: string): string {
  const url = new URL(input.trim())
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Enter the HTTPS address of your Kaneo instance, without a path.')
  }
  return url.origin
}

export function parseKaneoTaskUrl(input: string): KaneoTaskLink | null {
  if (!isSmartWorkspaceSourceQueryWithinLimit(input)) {
    return null
  }
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'https:' || url.username || url.password) {
      return null
    }
    const match = TASK_PATH.exec(url.pathname)
    if (!match) {
      return null
    }
    const [, workspaceId, projectId, taskId] = match
    return {
      siteUrl: url.origin,
      workspaceId,
      projectId,
      taskId,
      url: `${url.origin}/dashboard/workspace/${workspaceId}/project/${projectId}/task/${taskId}`
    }
  } catch {
    return null
  }
}
