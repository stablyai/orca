import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'

export function isOpenCode2LaunchCommand(launchCommand: string | undefined): boolean {
  const binary = getCommandTokenPathBasename(getFirstCommandToken(launchCommand ?? ''))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
  return binary === 'opencode2'
}
