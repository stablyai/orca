import { quoteStartupArg } from '../../../src/shared/tui-agent-startup-shell'

export function buildFakeAgentCommandOverride(
  executablePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const shell = platform === 'win32' ? 'powershell' : 'posix'
  const quotedPath = quoteStartupArg(executablePath, shell)
  return platform === 'win32' ? `& ${quotedPath}` : quotedPath
}
