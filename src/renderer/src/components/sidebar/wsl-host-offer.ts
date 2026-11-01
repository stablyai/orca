import { parseWslUncPath } from '../../../../shared/wsl-paths'
import type { AppState } from '@/store/types'
import { wslHostsAvailable } from './use-wsl-hosts-enabled'

export type WslHostOfferGate = {
  /** WSL hosts can take new work here: Windows (or its e2e fake), gate open, server files shipped. */
  gateOpen: boolean
  settingOn: boolean
  dismissed: boolean
}

/** The distro a `\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…` path names; never asks WSL. */
export function wslHostOfferDistro(path: string): string | null {
  return parseWslUncPath(path)?.distro ?? null
}

export function shouldOfferWslHost(gate: WslHostOfferGate): boolean {
  return gate.gateOpen && !gate.settingOn && !gate.dismissed
}

export function readWslHostOfferGate(
  state: Pick<AppState, 'settings' | 'wslHostsAcceptNewWork' | 'wslHostServerFiles'>
): WslHostOfferGate {
  return {
    gateOpen:
      wslHostsAvailable() && state.wslHostsAcceptNewWork && state.wslHostServerFiles !== 'missing',
    settingOn: state.settings?.experimentalWslHosts === true,
    dismissed: state.settings?.wslHostOfferDismissed === true
  }
}

/** The distro to offer for `path`, or null where the add goes ahead as before. */
export function wslHostOfferFor(path: string, gate: WslHostOfferGate): string | null {
  return shouldOfferWslHost(gate) ? wslHostOfferDistro(path) : null
}
