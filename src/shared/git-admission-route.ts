import { createHash } from 'node:crypto'
import path from 'node:path'
import { findGitSubcommandIndex } from './git-command-classification'
import type { GitAdmissionRequest } from './git-admission-state'
import { uncRouteKey } from './wsl-paths'

export function gitAdmissionRoute(request: GitAdmissionRequest): string | null {
  const distro = request.wslDistro?.trim().toLowerCase()
  const route = distro ? `wsl:${distro}` : uncRouteKey(request.cwd)
  if (
    route ||
    request.tier === 'interactive' ||
    request.args[findGitSubcommandIndex(request.args)] !== 'status'
  ) {
    return route
  }
  const cwd = path.resolve(request.cwd)
  const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd
  // Admission events must not expose working-directory paths.
  return `status:${createHash('sha256').update(key).digest('hex')}`
}
