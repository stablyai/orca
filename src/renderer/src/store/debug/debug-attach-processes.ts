import type { DebugAdapterId, DebugLaunchConfig } from './debug-session-types'

export type DebugAttachKind = 'java' | 'node' | 'python' | 'go' | 'native'

export type DebugAttachableProcess = {
  pid: number
  name: string
  commandLine: string
  kind: DebugAttachKind
  adapter: string
  host?: string | null
  port?: number | null
}

export type DebugAttachRow =
  | { kind: 'group'; key: string; label: string; count: number }
  | { kind: 'process'; key: string; process: DebugAttachableProcess }

export const ATTACH_KIND_LABELS: Record<DebugAttachKind, string> = {
  node: 'Node.js',
  python: 'Python (debugpy)',
  go: 'Go (Delve)',
  native: 'Native (LLDB)',
  java: 'Java (JDWP)'
}

const ATTACH_KIND_ORDER: readonly DebugAttachKind[] = ['node', 'python', 'go', 'native', 'java']

export function matchesAttachFilter(proc: DebugAttachableProcess, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return true
  }
  const haystack = `${proc.pid} ${proc.name} ${proc.commandLine}`.toLowerCase()
  return words.every((w) => haystack.includes(w))
}

export function buildAttachRows(
  list: readonly DebugAttachableProcess[],
  filter: string
): DebugAttachRow[] {
  const rows: DebugAttachRow[] = []
  for (const kind of ATTACH_KIND_ORDER) {
    const items = list.filter((proc) => proc.kind === kind && matchesAttachFilter(proc, filter))
    if (items.length === 0) {
      continue
    }
    rows.push({
      kind: 'group',
      key: `group:${kind}`,
      label: ATTACH_KIND_LABELS[kind],
      count: items.length
    })
    for (const process of items) {
      rows.push({ kind: 'process', key: `${kind}:${process.pid}`, process })
    }
  }
  return rows
}

export function formatAttachDetail(proc: DebugAttachableProcess): string {
  if (proc.port != null) {
    return `${proc.host ?? 'localhost'}:${proc.port}`
  }
  return `pid ${proc.pid}`
}

function toAdapterId(raw: string, fallback: DebugAdapterId): DebugAdapterId {
  if (
    raw === 'debugpy' ||
    raw === 'js-debug' ||
    raw === 'codelldb' ||
    raw === 'delve' ||
    raw === 'lldb-dap' ||
    raw === 'netcoredbg' ||
    raw === 'rdbg'
  ) {
    return raw
  }
  return fallback
}

export function buildAttachLaunchConfig(
  proc: DebugAttachableProcess,
  cwd?: string | null
): DebugLaunchConfig {
  const normalizedCwd = cwd?.trim() || undefined
  const base = (adapter: DebugAdapterId, extra: Record<string, unknown>): DebugLaunchConfig => ({
    name: `${proc.name} (${proc.pid})`,
    adapter,
    request: 'attach',
    program: undefined,
    args: [],
    cwd: normalizedCwd,
    env: {},
    extraJson: JSON.stringify(extra)
  })

  switch (proc.kind) {
    case 'node':
      return base('js-debug', {
        type: 'pwa-node',
        ...(proc.port != null
          ? { address: proc.host ?? 'localhost', port: proc.port }
          : { processId: String(proc.pid) }),
        continueOnAttach: true
      })
    case 'python':
      return base(
        'debugpy',
        proc.port != null ? { debugServer: proc.port } : { processId: proc.pid }
      )
    case 'go':
      return base('delve', { mode: 'local', processId: proc.pid })
    case 'native':
      return base(toAdapterId(proc.adapter, 'codelldb'), { pid: proc.pid })
    case 'java':
      return base(toAdapterId(proc.adapter, 'lldb-dap'), {
        hostName: proc.host ?? 'localhost',
        port: proc.port ?? 5005
      })
  }
}
