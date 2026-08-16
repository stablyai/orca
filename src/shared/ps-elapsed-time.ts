/**
 * Parses `ps -o etime=` / `ps -o etimes=` output. macOS and Linux (procps)
 * both format elapsed time as `[[DD-]HH:]MM:SS`; this is the one parser both
 * the memory collector and the port scanner use.
 */
export function parsePsElapsedTimeToSeconds(etime: string): number | undefined {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!match) {
    return undefined
  }
  const days = match[1] ? Number.parseInt(match[1], 10) : 0
  const hours = match[2] ? Number.parseInt(match[2], 10) : 0
  const minutes = Number.parseInt(match[3], 10)
  const seconds = Number.parseInt(match[4], 10)
  if ([days, hours, minutes, seconds].some((value) => Number.isNaN(value))) {
    return undefined
  }
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

/** .NET ticks (100ns units) between the .NET epoch (0001-01-01) and the Unix epoch. */
const DOTNET_TICKS_UNIX_EPOCH_OFFSET = 621_355_968_000_000_000n
const DOTNET_TICKS_PER_MS = 10_000n

/** Converts a `DateTime.Ticks` value (from `CreationDate.ToUniversalTime().Ticks`) to a Unix ms timestamp. */
export function dotnetTicksToUnixMs(ticks: bigint): number {
  return Number((ticks - DOTNET_TICKS_UNIX_EPOCH_OFFSET) / DOTNET_TICKS_PER_MS)
}
