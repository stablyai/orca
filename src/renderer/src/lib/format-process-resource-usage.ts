/** Shared by the Resource Manager and Ports panels so both read the same units. */

export function formatProcessCpuPercent(percent: number): string {
  return `${percent.toFixed(1)}%`
}

export function formatProcessMemoryBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatOptionalProcessCpuPercent(value: number | null | undefined): string {
  return value == null ? '—' : formatProcessCpuPercent(value)
}

export function formatOptionalProcessMemoryBytes(value: number | null | undefined): string {
  return value == null ? '—' : formatProcessMemoryBytes(value)
}

export function formatProcessUptime(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m`
  }
  return `${Math.max(0, Math.floor(seconds))}s`
}

export function formatOptionalProcessUptime(value: number | null | undefined): string {
  return value == null ? '—' : formatProcessUptime(value)
}
