import type { Repo } from './repo-types'
import { quoteStartupArg } from './agent-launch/startup/tui-agent-startup-shell'

export function projectGroupSetupExample(
  repos: readonly Pick<Repo, 'id' | 'displayName'>[],
  platform: NodeJS.Platform
): string {
  const windows = platform === 'win32'
  const comment = windows ? 'REM' : '#'
  const shell = windows ? 'cmd' : 'posix'
  const workspaceName = windows ? '"%ORCA_WORKSPACE_NAME%"' : '"$ORCA_WORKSPACE_NAME"'
  return [
    `${comment} Repo IDs are local to this machine; review them before sharing this script.`,
    ...repos.flatMap((repo) => [
      `${comment} ${repo.displayName.replace(windows ? /[^\p{L}\p{N} ._/-]/gu : /[\r\n]/g, ' ')}`,
      `orca worktree create --repo ${quoteStartupArg(`id:${repo.id}`, shell)} --name ${workspaceName} --json`
    ])
  ].join('\n')
}
