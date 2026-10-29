import { join } from 'node:path'
import { runProcess, runProcessSync } from '@orca/process-host'

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

/** Bounded synchronous adapter for the pre-ready launch decision. */
export function listProcessCommandsSync(): string | null {
  try {
    const result = runProcessSync({
      program: '/bin/ps',
      args: ['-axww', '-o', 'command='],
      timeoutMs: 1000,
      maxOutputBytes: 8 * 1024 * 1024
    })
    return result.code === 0 && !result.timedOut && !result.outputTruncated ? result.stdout : null
  } catch {
    return null
  }
}

/** Native argv is [ShipIt, jobLabel, statePath]; the launch-only helper is not an installer. */
export function shipItInstallRequestsForBundle(
  listing: string,
  bundlePath: string
): { label: string; statePath: string }[] {
  const framework = join(bundlePath, 'Contents', 'Frameworks', 'Squirrel.framework')
  const binaries = ['/Resources/ShipIt', '/Versions/A/Resources/ShipIt'].map(
    (suffix) => framework + suffix
  )
  return lines(listing).flatMap((command) => {
    const binary = binaries.find((path) => command.startsWith(`${path} `))
    if (!binary) {
      return []
    }
    const args = /^(\S+\.ShipIt) (\/[^\r\n]+)$/.exec(command.slice(binary.length + 1))
    return args ? [{ label: args[1]!, statePath: args[2]! }] : []
  })
}
