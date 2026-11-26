import { homedir } from 'node:os'
import path from 'node:path'
import {
  runCliFsReadsAsync,
  type CliFsProbeOptions
} from '../../shell/command-resolution/cli-fs-reads'
import type { InventoryFsProbes } from '../../shell/command-resolution/inventory-fs-probes'
import {
  cliInstallDirectories,
  firstRunnable,
  getExecutableNames
} from '../../shell/command-resolution/node-cli-command-resolution'

export async function detectCommandsInInstallDirs(
  commands: readonly string[],
  {
    probes,
    needsLookup,
    readDirectories,
    complete
  }: {
    probes: InventoryFsProbes
    needsLookup: (command: string) => Promise<boolean>
    readDirectories: NonNullable<CliFsProbeOptions['readDirectories']>
    complete: (command: string, user: string | null, uncertain: boolean) => void
  }
): Promise<void> {
  const platform = process.platform
  let directories: Promise<string[]> | undefined
  let unverifiedDirectories = false
  await Promise.all(
    commands.map(async (command) => {
      if (!(await needsLookup(command)) || probes.signal.aborted) {
        return
      }
      directories ??= runCliFsReadsAsync(cliInstallDirectories(platform, homedir()), {
        probes,
        readDirectories,
        onUnverified: () => {
          unverifiedDirectories = true
        }
      })
      const dirs = await directories
      let uncertain = unverifiedDirectories
      const user = await runCliFsReadsAsync(
        firstRunnable(platform, dirs, getExecutableNames(platform, command)),
        {
          probes,
          onUnverified: () => {
            uncertain = true
          }
        }
      )
      complete(command, user && path.isAbsolute(user) ? user : null, uncertain)
    })
  )
}
