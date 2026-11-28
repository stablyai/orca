import type { WslHostDistro } from '../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { canAddWslDistro } from '@/components/sidebar/host-admission/wsl/wsl-host-distro-model'

export type WslDistroMenuRow = { distro: WslHostDistro; disabled: boolean }

/** Distros that can become hosts here; ones already added are Computer rows, and main already hides Docker's. */
export function wslDistroMenuRows(distros: readonly WslHostDistro[]): WslDistroMenuRow[] {
  return distros
    .filter((distro) => distro.environmentId === null)
    .map((distro) => ({ distro, disabled: !canAddWslDistro(distro) }))
}
