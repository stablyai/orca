import { homedir } from 'node:os'
import path from 'node:path'
import {
  runCliFsReadsAsync,
  type CliFsProbeOptions
} from '../../shell/command-resolution/cli-fs-reads'
import type { InventoryFsProbes } from '../../shell/command-resolution/inventory-fs-probes'
import {
  cliInstallDirectories,
  cliInstallDirectoriesForCommand,
  firstRunnable,
  getExecutableNames
} from '../../shell/command-resolution/node-cli-command-resolution'

export async function detectCommandsInInstallDirs(
  commands: readonly string[],
  {
    probes,
    readDirectories,
    acceptsExecutableTarget,
    complete
  }: {
    probes: InventoryFsProbes
    readDirectories: NonNullable<CliFsProbeOptions['readDirectories']>
    acceptsExecutableTarget: NonNullable<CliFsProbeOptions['acceptsExecutableTarget']>
    complete: (command: string, user: string | null, uncertain: boolean) => void
  }
): Promise<void> {
  const platform = process.platform
  let unverifiedDirectories = false
  const home = homedir()
  const dirs = await runCliFsReadsAsync(cliInstallDirectories(platform, home), {
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
        firstRunnable(
          platform,
          cliInstallDirectoriesForCommand(dirs, platform, home, command),
          getExecutableNames(platform, command)
        ),
        {
          probes,
          acceptsExecutableTarget,
          onUnverified: () => {
            uncertain = true
          }
        }
      )
      complete(command, user && path.isAbsolute(user) ? user : null, uncertain)
    })
  )
}
