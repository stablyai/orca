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
    readDirectories,
    complete
  }: {
    probes: InventoryFsProbes
    readDirectories: NonNullable<CliFsProbeOptions['readDirectories']>
    complete: (command: string, user: string | null, uncertain: boolean) => void
  }
): Promise<void> {
  const platform = process.platform
  let unverifiedDirectories = false
  const dirs = await runCliFsReadsAsync(cliInstallDirectories(platform, homedir()), {
    probes,
    readDirectories,
    onUnverified: () => {
      unverifiedDirectories = true
    }
  })
  await Promise.all(
    commands.map(async (command) => {
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
