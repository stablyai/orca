import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

const SHIPIT_BINARY_SUFFIX = '/Squirrel.framework/Resources/ShipIt'

/** `ps` is one short-lived fork with no interpreter; a failure is reported as unknown, not clear. */
export async function listProcessCommands(): Promise<string | null> {
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-axww', '-o', 'command='],
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024 * 1024,
      killOnOutputLimit: true
    })
    return result.code === 0 && !result.timedOut && !result.outputTruncated ? result.stdout : null
  } catch {
    return null
  }
}

const lines = (listing: string): string[] => listing.split('\n').map((line) => line.trimStart())

/** ShipIt runs from inside the bundle it replaces, so its command line names that bundle. */
export function isShipItRunningForBundle(listing: string, bundlePath: string): boolean {
  const prefix = `${join(bundlePath, 'Contents', 'Frameworks', 'Squirrel.framework')}/`
  return lines(listing).some(
    (command) =>
      command.startsWith(prefix) && command.slice(prefix.length).split(' ')[0].endsWith('/ShipIt')
  )
}

/** ShipIt for this bundle id: launchd starts it with its `<bundle id>.ShipIt` job label. */
export function isShipItRunningForBundleId(listing: string, bundleId: string): boolean {
  const label = ` ${bundleId}.ShipIt`
  return lines(listing).some(
    (command) => command.includes(`${SHIPIT_BINARY_SUFFIX} `) && command.includes(label)
  )
}
