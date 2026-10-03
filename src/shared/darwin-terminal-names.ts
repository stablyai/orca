import { lstat, readdir } from 'node:fs/promises'

// Host-only: reads /dev. The renderer-safe process-table module must never import this one.

// A macOS full-capture row up to its device column: pid, ppid, pgid, tpgid, stat, then
// `major/minor`, followed by the five-field `lstart=` marker. Anchoring on lstart keeps any other
// row shape (legacy captures, an argv that happens to contain `1/2`) untouched.
const DARWIN_TDEV_COLUMN =
  /^(\s*\d+\s+\d+\s+-?\d+\s+-?\d+\s+\S+\s+)(\d+\/\d+)(?=\s+\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4}\s)/gm

/** The distinct `major/minor` terminal devices a macOS `tdev=` capture names. */
export function listDarwinTerminalDevices(stdout: string): Set<string> {
  const devices = new Set<string>()
  for (const match of stdout.matchAll(DARWIN_TDEV_COLUMN)) {
    devices.add(match[2])
  }
  return devices
}

/**
 * Rewrite a macOS `tdev=` capture's device column into the terminal name `tty=` prints for it
 * (`16/79` becomes `ttys079`), so every consumer keeps comparing the strings it always has. `??`
 * (no controlling terminal) is already what `tty=` prints and stays. A device `nameFor` cannot
 * name keeps its `major/minor` spelling: still equal across the rows on that one terminal, and
 * never equal to another terminal's name.
 */
export function translateDarwinTerminalDevices(
  stdout: string,
  nameFor: (device: string) => string | undefined
): string {
  return stdout.replace(
    DARWIN_TDEV_COLUMN,
    (_row, head: string, device: string) => head + (nameFor(device) ?? device)
  )
}

type DarwinTerminalNameDeps = {
  readdir: (path: string) => Promise<string[]>
  lstat: (path: string) => Promise<{ isCharacterDevice: () => boolean; rdev: number }>
}

export type DarwinTerminalNameIndex = {
  resolve: (devices: ReadonlySet<string>) => Promise<ReadonlyMap<string, string>>
}

/**
 * `major/minor` to /dev name for macOS terminals: the lookup `ps -o tty=` does with devname(3)
 * for every process, done here once and kept. Only `tty*` and `console` entries can name a
 * controlling terminal, so the rest of /dev is never stat'ed; the first entry carrying a device
 * wins, as in devname's own walk. A capture naming a device the index lacks (a terminal opened
 * since) rebuilds it once before translating.
 */
export function createDarwinTerminalNameIndex(
  deps: DarwinTerminalNameDeps = { readdir, lstat }
): DarwinTerminalNameIndex {
  let names: Map<string, string> | null = null
  // Devices a fresh walk could not name either: a process can outlive the terminal node it was
  // started on. Remembered so that one such process does not cost a walk of /dev per capture.
  let unnamed = new Set<string>()

  async function build(): Promise<Map<string, string>> {
    const entries = (await deps.readdir('/dev')).filter(
      (name) => name.startsWith('tty') || name === 'console'
    )
    const stats = await Promise.all(
      entries.map((name) => deps.lstat(`/dev/${name}`).catch(() => null))
    )
    const built = new Map<string, string>()
    entries.forEach((name, index) => {
      const stat = stats[index]
      if (!stat?.isCharacterDevice()) {
        return
      }
      // Darwin's dev_t: major in the top byte, minor in the low 24 bits, as `ps -o tdev=` prints.
      const device = `${(stat.rdev >>> 24) & 0xff}/${stat.rdev & 0xffffff}`
      if (!built.has(device)) {
        built.set(device, name)
      }
    })
    return built
  }

  return {
    resolve: async (devices) => {
      let current = names ?? (names = await build())
      const missing = [...devices].filter((device) => !current.has(device) && !unnamed.has(device))
      if (missing.length > 0) {
        current = names = await build()
        unnamed = new Set(missing.filter((device) => !current.has(device)))
      }
      return current
    }
  }
}

const sharedIndex = createDarwinTerminalNameIndex()

/**
 * Give a macOS `tdev=` capture the terminal names `tty=` would have printed. Best effort: if /dev
 * cannot be read the capture keeps its `major/minor` spellings, which still tell terminals apart,
 * rather than turning a readable process table into a failed one. The next capture retries.
 */
export async function nameDarwinTerminals(
  stdout: string,
  index: DarwinTerminalNameIndex = sharedIndex
): Promise<string> {
  const devices = listDarwinTerminalDevices(stdout)
  if (devices.size === 0) {
    return stdout
  }
  let names: ReadonlyMap<string, string>
  try {
    names = await index.resolve(devices)
  } catch {
    return stdout
  }
  return translateDarwinTerminalDevices(stdout, (device) => names.get(device))
}
