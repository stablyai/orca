import type { PreloadApi } from '../../../preload/api-types'
import type { CliInstallStatus } from '../../../shared/cli/cli-install-types'
import { callRuntimeResult } from './runtime/client/web-runtime-calls'

type CliApi = NonNullable<Partial<PreloadApi>['cli']>

/** Routes CLI registration through the paired local orcad instead of the browser fallback. */
export function createTauriNativeCliApi(): CliApi {
  return {
    getInstallStatus: () => callRuntimeResult<CliInstallStatus>('cli.getInstallStatus'),
    install: () => callRuntimeResult<CliInstallStatus>('cli.install'),
    remove: () => callRuntimeResult<CliInstallStatus>('cli.remove'),
    getWslInstallStatus: (args) =>
      callRuntimeResult<CliInstallStatus>('cli.getWslInstallStatus', {
        distro: args?.distro ?? null
      }),
    installWsl: (args) =>
      callRuntimeResult<CliInstallStatus>('cli.installWsl', {
        distro: args?.distro ?? null
      }),
    removeWsl: (args) =>
      callRuntimeResult<CliInstallStatus>('cli.removeWsl', {
        distro: args?.distro ?? null
      })
  }
}
