import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { DirectoryListingBudget } from './directory-listing-budget'
import { ProcessTableCaptureError } from './process-table-snapshot'

type DarwinTerminalNameDeps = {
  openDirectory: (path: string) => Promise<AsyncIterable<{ name: string }>>
  readDevice: (path: string) => Promise<{ rdev: bigint; isCharacterDevice: () => boolean }>
}

const deviceFilesystem: DarwinTerminalNameDeps = {
  openDirectory: (path) => opendir(path),
  readDevice: (path) => lstat(path, { bigint: true })
}

// The full capture's first six columns are fixed; localized dates and argv stay opaque.
const TDEV_COLUMN =
  /^([^\S\r\n]*\d+[^\S\r\n]+\d+[^\S\r\n]+-?\d+[^\S\r\n]+-?\d+[^\S\r\n]+\S+[^\S\r\n]+)(\S+)(?=[^\S\r\n]+\S)/
const TDEV_COLUMNS = new RegExp(TDEV_COLUMN.source, 'gm')

function deviceToken(value: string): string | null {
  const match = value.match(/^(\d+)\/(\d+)$/)
  if (!match || Number(match[1]) > 255 || Number(match[2]) > 0xffffff) {
    return null
  }
  return `${Number(match[1])}/${Number(match[2])}`
}

function deviceKey(rdev: bigint): string | null {
  const device = BigInt.asUintN(32, rdev)
  const signedDevice = BigInt.asIntN(32, rdev)
  if (rdev !== device && rdev !== signedDevice && rdev !== BigInt.asUintN(64, signedDevice)) {
    return null
  }
  return `${device >> 24n}/${device & 0xffffffn}`
}

async function readDeviceKey(deps: DarwinTerminalNameDeps, name: string): Promise<string | null> {
  try {
    const stat = await deps.readDevice(join('/dev', name)).catch(() => null)
    return stat?.isCharacterDevice() ? deviceKey(stat.rdev) : null
  } catch {
    return null
  }
}

// XNU names every pty slave ttys%03d by minor with one /dev entry; verify rdev before trusting it.
// Unlike devname, a root-made earlier alias of a pty cannot win here.
async function readPtyNames(
  devices: ReadonlySet<string>,
  deps: DarwinTerminalNameDeps,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const device of devices) {
    signal?.throwIfAborted()
    const name = `ttys${device.slice(device.indexOf('/') + 1).padStart(3, '0')}`
    if ((await readDeviceKey(deps, name)) === device) {
      names.set(device, name)
    }
  }
  signal?.throwIfAborted()
  return names
}

async function readTerminalNames(
  devices: ReadonlySet<string>,
  names: Map<string, string>,
  deps: DarwinTerminalNameDeps,
  signal?: AbortSignal
): Promise<void> {
  const entries: string[] = []
  const budget = new DirectoryListingBudget()
  signal?.throwIfAborted()
  for await (const entry of await deps.openDirectory('/dev')) {
    signal?.throwIfAborted()
    if (entry.name.includes('\uFFFD')) {
      throw new ProcessTableCaptureError('undecodable_device_name')
    }
    budget.record(entry.name)
    entries.push(entry.name)
  }
  let unresolved = [...devices].filter((device) => !names.has(device)).length
  for (const name of entries) {
    if (unresolved === 0) {
      break
    }
    signal?.throwIfAborted()
    const device = await readDeviceKey(deps, name)
    // Apple devname chooses the first direct character entry in native directory order.
    if (device !== null && devices.has(device) && !names.has(device)) {
      names.set(device, Buffer.byteLength(name, 'utf8') < 255 ? name : '??')
      unresolved -= 1
    }
  }
  signal?.throwIfAborted()
}

/** Name terminals using this capture's /dev inventory, without retaining positive or misses. */
export async function nameDarwinTerminals(
  stdout: string,
  deps: DarwinTerminalNameDeps = deviceFilesystem,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const devices = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    const match = line.match(TDEV_COLUMN)
    if (!match) {
      throw new ProcessTableCaptureError('malformed_darwin_device_row')
    }
    const device = deviceToken(match[2])
    if (device !== null) {
      devices.add(device)
    }
  }
  const names = await readPtyNames(devices, deps, signal)
  if (names.size < devices.size) {
    await readTerminalNames(devices, names, deps, signal)
  }
  return stdout.replace(TDEV_COLUMNS, (_row, head: string, device: string) => {
    return head + (names.get(deviceToken(device) ?? '') ?? '??')
  })
}
