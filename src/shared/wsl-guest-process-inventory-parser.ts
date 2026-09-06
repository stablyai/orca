/** A process row read inside one WSL distro. */
export type WslGuestProcessRow = {
  pid: number
  ppid: number
  sid: number
  pgid: number
  tpgid: number
  tty: string
  stat: string
  startTimeTicks: number
  command: string
}

export type WslGuestProcessInventory = {
  distro: string
  bootId: string
  rows: readonly WslGuestProcessRow[]
}

export function parseWslGuestProcessInventoryPayload(
  payload: string,
  distro: string
): WslGuestProcessInventory {
  let bootId: string | null = null
  let expectedCount: number | null = null
  let seenCount: number | null = null
  let skippedCount: number | null = null
  const rows: WslGuestProcessRow[] = []
  const pids = new Set<number>()
  const skippedPids = new Set<number>()
  for (const rawLine of payload.split(/\r?\n/)) {
    // Remove only the transport CR; trailing spaces belong to the command
    // remainder and must not be normalized away.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      continue
    }
    const boot = line.match(/^boot ([A-Fa-f0-9-]{8,128})$/)
    if (boot) {
      if (bootId !== null) {
        throw new Error('duplicate_boot_id')
      }
      bootId = boot[1]!
      continue
    }
    const count = line.match(/^count (\d+) (\d+)(?: (\d+))?$/)
    if (count) {
      if (seenCount !== null) {
        throw new Error('duplicate_count')
      }
      seenCount = Number(count[1])
      expectedCount = Number(count[2])
      skippedCount = count[3] === undefined ? 0 : Number(count[3])
      continue
    }
    const skipped = line.match(/^skip (\d+)$/)
    if (skipped) {
      const pid = Number(skipped[1])
      if (!Number.isSafeInteger(pid) || pid <= 0 || pids.has(pid) || skippedPids.has(pid)) {
        throw new Error('invalid_row')
      }
      skippedPids.add(pid)
      continue
    }
    const row = line.match(/^row (\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\S+) (\S+) (\d+)(?: (.*))?$/)
    if (!row) {
      throw new Error('malformed_row')
    }
    const values = [1, 2, 3, 4, 5, 8].map((index) => Number(row[index]))
    const [pid, ppid, sid, pgid, tpgid, startTimeTicks] = values
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      !Number.isSafeInteger(sid) ||
      sid < 0 ||
      !Number.isSafeInteger(pgid) ||
      pgid < 0 ||
      !Number.isSafeInteger(tpgid) ||
      (tpgid < 0 && tpgid !== -1) ||
      !Number.isSafeInteger(startTimeTicks) ||
      startTimeTicks < 0 ||
      pids.has(pid)
    ) {
      throw new Error('invalid_row')
    }
    pids.add(pid)
    rows.push({
      pid,
      ppid,
      sid,
      pgid,
      tpgid,
      tty: row[6]!,
      stat: row[7]!,
      startTimeTicks,
      command: row[9] ?? ''
    })
  }
  if (!bootId) {
    throw new Error('boot_id_missing')
  }
  if (
    seenCount === null ||
    expectedCount === null ||
    skippedCount === null ||
    seenCount !== rows.length ||
    skippedCount !== skippedPids.size ||
    seenCount + skippedCount !== expectedCount
  ) {
    throw new Error('row_count_mismatch')
  }
  return { distro, bootId, rows }
}
