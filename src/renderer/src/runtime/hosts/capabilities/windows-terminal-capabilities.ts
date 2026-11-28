export type { WindowsTerminalCapabilities } from './windows-terminal-capability-cache'

export {
  getCachedWindowsTerminalCapabilities,
  getProbedLocalGitBashAvailability,
  getWindowsTerminalCapabilityOwnerKey,
  hasCachedWindowsTerminalCapabilities,
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from './windows-terminal-capability-cache'

export {
  selectWindowsTerminalCapabilitiesForOwner,
  useLocalWindowsTerminalCapabilities,
  useWindowsTerminalCapabilities
} from './use-windows-terminal-capabilities'

export { isWindowsTerminalCapabilityHost } from './windows-terminal-capability-host'
