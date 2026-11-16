import { access, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { SERVE_LAUNCHD_LABEL_PREFIX } from './serve-bundle-coordination'

/** One `orca serve service install` unit; profiles other than the default carry a hash suffix. */
export type InstalledServeServiceUnit = {
  manager: 'launchd' | 'systemd'
  name: string
  unitPath: string
}

export type ServeServiceRun = (
  program: string,
  args: string[]
) => Promise<{ code: number | null; out: string }>

export const runServeServiceManager: ServeServiceRun = async (program, args) => {
  try {
    const result = await runProcess({ program, args, timeoutMs: 20_000 })
    return { code: result.timedOut ? null : result.code, out: `${result.stdout}${result.stderr}` }
  } catch (error) {
    return { code: null, out: error instanceof Error ? error.message : String(error) }
  }
}

function launchdDir(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents')
}

function systemdDir(homeDir: string): string {
  return join(homeDir, '.config', 'systemd', 'user')
}

async function listNames(dir: string, matches: (file: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(matches)
  } catch {
    return []
  }
}

export async function listInstalledServeServiceUnits(
  platform: NodeJS.Platform,
  homeDir: string
): Promise<InstalledServeServiceUnit[]> {
  if (platform === 'darwin') {
    const dir = launchdDir(homeDir)
    const label = new RegExp(
      `^${SERVE_LAUNCHD_LABEL_PREFIX.replace(/\./g, '\\.')}(\\.[0-9a-f]{8})?\\.plist$`
    )
    return (await listNames(dir, (file) => label.test(file))).map(
      (file): InstalledServeServiceUnit => ({
        manager: 'launchd',
        name: file.slice(0, -'.plist'.length),
        unitPath: join(dir, file)
      })
    )
  }
  if (platform === 'linux') {
    const dir = systemdDir(homeDir)
    return (await listNames(dir, (file) => /^orca-serve(-[0-9a-f]{8})?\.service$/.test(file))).map(
      (file): InstalledServeServiceUnit => ({
        manager: 'systemd',
        name: file,
        unitPath: join(dir, file)
      })
    )
  }
  return []
}

/** Stops the unit, then deletes it; true when a unit file was there. */
export async function removeServeServiceUnit(
  unit: InstalledServeServiceUnit,
  run: ServeServiceRun,
  uid: number
): Promise<boolean> {
  await (unit.manager === 'launchd'
    ? run('launchctl', ['bootout', `gui/${uid}/${unit.name}`])
    : run('systemctl', ['--user', 'disable', '--now', unit.name]))
  const existed = await access(unit.unitPath).then(
    () => true,
    () => false
  )
  await rm(unit.unitPath, { force: true })
  if (unit.manager === 'systemd') {
    await run('systemctl', ['--user', 'daemon-reload'])
  }
  return existed
}
