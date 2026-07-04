import type { HostSessionAgent } from '../../../../shared/host-session-types'

const BYTES_PER_GIB = 1024 ** 3

/** Formats a byte count as gigabytes with one decimal (e.g. 9.9). */
export function formatGib(bytes: number): string {
  return (Math.max(0, bytes) / BYTES_PER_GIB).toFixed(1)
}

/** Formats a load average with two decimals, matching uptime(1) conventions. */
export function formatLoad(value: number): string {
  return Math.max(0, value).toFixed(2)
}

/** Compact human uptime: "3d 4h", "4h 12m", or "12m". */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

/** Tailwind color class for a session's detected agent, for the status dot. */
export function agentDotClass(agent: HostSessionAgent): string {
  switch (agent) {
    case 'claude':
      return 'bg-orange-500'
    case 'codex':
      return 'bg-emerald-500'
    case null:
      return 'bg-muted-foreground/40'
  }
}

/** Percent clamped to [0, 100] and rounded, for progress rendering. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round(value)))
}
