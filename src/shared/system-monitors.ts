export type SystemMonitorCategory = 'system' | 'containers' | 'gpu' | 'disk' | 'io'

export type SystemMonitorRuntime = NodeJS.Platform | 'wsl'

export type SystemMonitorId =
  | 'btop'
  | 'htop'
  | 'btm'
  | 'glances'
  | 'atop'
  | 's-tui'
  | 'top'
  | 'lazydocker'
  | 'ctop'
  | 'oxker'
  | 'docker-stats'
  | 'podman-stats'
  | 'k9s'
  | 'nvtop'
  | 'radeontop'
  | 'ncdu'
  | 'duf'
  | 'iotop'
  | 'nethogs'
  | 'iftop'
  | 'bandwhich'

export type SystemMonitorDescriptor = {
  readonly id: SystemMonitorId
  readonly label: string
  /** Executable name probed on the host PATH. */
  readonly binary: string
  /** Shell command executed when launching the monitor in a new terminal tab. */
  readonly command: string
  readonly category: SystemMonitorCategory
  readonly categoryLabel: string
  readonly keywords: readonly string[]
  /** Optional runtime filter; omitted means supported on every platform where the binary exists. */
  readonly runtimes?: readonly SystemMonitorRuntime[]
}

const UNIX_LIKE_RUNTIMES: readonly SystemMonitorRuntime[] = [
  'darwin',
  'linux',
  'freebsd',
  'openbsd',
  'wsl'
]

function defineMonitor(
  id: SystemMonitorId,
  label: string,
  binary: string,
  command: string,
  category: SystemMonitorCategory,
  categoryLabel: string,
  keywordTerms: readonly string[],
  runtimes?: readonly SystemMonitorRuntime[]
): SystemMonitorDescriptor {
  return runtimes
    ? { id, label, binary, command, category, categoryLabel, keywords: keywordTerms, runtimes }
    : { id, label, binary, command, category, categoryLabel, keywords: keywordTerms }
}

const COMMON_TERMS = ['top', 'monitor'] as const

export const KNOWN_SYSTEM_MONITORS: readonly SystemMonitorDescriptor[] = [
  defineMonitor('btop', 'btop', 'btop', 'btop', 'system', 'System', [
    'btop', 'system', 'cpu', 'memory', 'processes', ...COMMON_TERMS
  ]),
  defineMonitor('htop', 'htop', 'htop', 'htop', 'system', 'System', [
    'htop', 'system', 'cpu', 'memory', 'processes', ...COMMON_TERMS
  ]),
  defineMonitor('btm', 'bottom (btm)', 'btm', 'btm', 'system', 'System', [
    'btm', 'bottom', 'system', 'cpu', 'memory', ...COMMON_TERMS
  ]),
  defineMonitor('glances', 'glances', 'glances', 'glances', 'system', 'System', [
    'glances', 'system', 'cpu', 'memory', 'docker', ...COMMON_TERMS
  ]),
  defineMonitor('atop', 'atop', 'atop', 'atop', 'system', 'System', [
    'atop', 'system', 'cpu', 'processes', ...COMMON_TERMS
  ], UNIX_LIKE_RUNTIMES),
  defineMonitor('s-tui', 's-tui', 's-tui', 's-tui', 'system', 'System', [
    's-tui', 'stui', 'thermal', 'frequency', 'cpu', ...COMMON_TERMS
  ], UNIX_LIKE_RUNTIMES),
  defineMonitor('lazydocker', 'lazydocker', 'lazydocker', 'lazydocker', 'containers', 'Docker', [
    'lazydocker', 'docker', 'container', 'containers', 'compose', 'logs', ...COMMON_TERMS
  ]),
  defineMonitor('ctop', 'ctop', 'ctop', 'ctop', 'containers', 'Docker', [
    'ctop', 'docker', 'container', 'containers', ...COMMON_TERMS
  ]),
  defineMonitor('oxker', 'oxker', 'oxker', 'oxker', 'containers', 'Docker', [
    'oxker', 'docker', 'container', 'containers', 'tui', ...COMMON_TERMS
  ]),
  defineMonitor('docker-stats', 'docker stats', 'docker', 'docker stats', 'containers', 'Docker', [
    'docker', 'docker stats', 'container', 'containers', 'stats', ...COMMON_TERMS
  ]),
  defineMonitor('podman-stats', 'podman stats', 'podman', 'podman stats', 'containers', 'Containers', [
    'podman', 'podman stats', 'container', 'containers', 'stats', ...COMMON_TERMS
  ]),
  defineMonitor('k9s', 'k9s', 'k9s', 'k9s', 'containers', 'Kubernetes', [
    'k9s', 'kubernetes', 'k8s', 'pods', 'cluster', 'containers', ...COMMON_TERMS
  ]),
  defineMonitor('nvtop', 'nvtop', 'nvtop', 'nvtop', 'gpu', 'GPU', [
    'nvtop', 'gpu', 'nvidia', 'amd', 'intel', 'vram', ...COMMON_TERMS
  ]),
  defineMonitor('radeontop', 'radeontop', 'radeontop', 'radeontop', 'gpu', 'GPU', [
    'radeontop', 'gpu', 'amd', 'radeon', 'vram', ...COMMON_TERMS
  ], UNIX_LIKE_RUNTIMES),
  defineMonitor('ncdu', 'ncdu', 'ncdu', 'ncdu', 'disk', 'Disk', [
    'ncdu', 'disk', 'storage', 'space', 'du', 'usage', 'monitor'
  ]),
  defineMonitor('duf', 'duf', 'duf', 'duf', 'disk', 'Disk', [
    'duf', 'df', 'disk', 'mounts', 'filesystems', 'storage', 'monitor'
  ]),
  defineMonitor('iotop', 'iotop', 'iotop', 'iotop', 'io', 'Disk I/O', [
    'iotop', 'io', 'disk', 'read', 'write', ...COMMON_TERMS
  ], UNIX_LIKE_RUNTIMES),
  defineMonitor('nethogs', 'nethogs', 'nethogs', 'nethogs', 'io', 'Network', [
    'nethogs', 'network', 'bandwidth', 'traffic', 'net', ...COMMON_TERMS
  ], UNIX_LIKE_RUNTIMES),
  defineMonitor('iftop', 'iftop', 'iftop', 'iftop', 'io', 'Network', [
    'iftop', 'network', 'bandwidth', 'interface', 'net', ...COMMON_TERMS
  ], UNIX_LIKE_RUNTIMES),
  defineMonitor('bandwhich', 'bandwhich', 'bandwhich', 'bandwhich', 'io', 'Network', [
    'bandwhich', 'network', 'bandwidth', 'processes', 'net', ...COMMON_TERMS
  ]),
  defineMonitor('top', 'top', 'top', 'top', 'system', 'System', [
    'system', 'cpu', 'memory', 'processes', ...COMMON_TERMS
  ], UNIX_LIKE_RUNTIMES)
]

const MONITOR_BY_ID = new Map<string, SystemMonitorDescriptor>(
  KNOWN_SYSTEM_MONITORS.map((descriptor) => [descriptor.id, descriptor])
)

/** Common presets offered on mobile when paired to an older host without `preflight.detectMonitors`. */
export const FALLBACK_MOBILE_SYSTEM_MONITOR_IDS: readonly SystemMonitorId[] = [
  'btop',
  'htop',
  'lazydocker',
  'ctop',
  'docker-stats',
  'ncdu',
  'top'
]

export function isSystemMonitorId(value: unknown): value is SystemMonitorId {
  return typeof value === 'string' && MONITOR_BY_ID.has(value)
}

export function getSystemMonitorDescriptor(id: SystemMonitorId): SystemMonitorDescriptor {
  const descriptor = MONITOR_BY_ID.get(id)
  if (!descriptor) {
    throw new Error(`Unknown system monitor id: ${id}`)
  }
  return descriptor
}

function supportsMonitorRuntime(
  descriptor: SystemMonitorDescriptor,
  runtime: SystemMonitorRuntime
): boolean {
  return !descriptor.runtimes || descriptor.runtimes.includes(runtime)
}

export function getSystemMonitorProbeBinaries(runtime: SystemMonitorRuntime): string[] {
  const unique = new Set<string>()
  for (const descriptor of KNOWN_SYSTEM_MONITORS) {
    if (supportsMonitorRuntime(descriptor, runtime)) {
      unique.add(descriptor.binary)
    }
  }
  return [...unique]
}

export function resolveDetectedSystemMonitorIds(
  foundBinaries: ReadonlySet<string> | readonly string[],
  runtime: SystemMonitorRuntime
): SystemMonitorId[] {
  const found = foundBinaries instanceof Set ? foundBinaries : new Set(foundBinaries)
  const detected: SystemMonitorId[] = []
  for (const descriptor of KNOWN_SYSTEM_MONITORS) {
    if (supportsMonitorRuntime(descriptor, runtime) && found.has(descriptor.binary)) {
      detected.push(descriptor.id)
    }
  }
  return detected
}

export function resolveSystemMonitorDescriptors(
  ids: readonly unknown[]
): SystemMonitorDescriptor[] {
  const seen = new Set<SystemMonitorId>()
  const resolved: SystemMonitorDescriptor[] = []
  for (const candidate of ids) {
    if (isSystemMonitorId(candidate) && !seen.has(candidate)) {
      seen.add(candidate)
      resolved.push(getSystemMonitorDescriptor(candidate))
    }
  }
  return resolved
}
