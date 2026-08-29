export const WINDOWS_PROCESS_TREE_RELAY_ARCHES = ['x64', 'arm64'] as const
export type WindowsProcessTreeRelayArch = (typeof WINDOWS_PROCESS_TREE_RELAY_ARCHES)[number]

export const WINDOWS_PROCESS_TREE_RELAY_CONTRACT_VERSION = 1
export const WINDOWS_PROCESS_TREE_RELAY_PACKAGE = '@vscode/windows-process-tree@0.8.0'

const WINDOWS_PROCESS_TREE_RELAY_SHA256: Record<WindowsProcessTreeRelayArch, string> = {
  x64: 'faf30d26b01ee082e1870e487cf1d0e913a574fbb58c631fc40e04f84da1a81d',
  arm64: 'b081a1d85d7e8692ef43186218ed4932f318b19e8ece635ea8f9891774d95640'
}

export function windowsProcessTreeRelaySha256(arch: WindowsProcessTreeRelayArch): string {
  return WINDOWS_PROCESS_TREE_RELAY_SHA256[arch]
}
