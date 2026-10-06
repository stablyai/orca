import { ensureLocalRuntimeCapabilities } from './local-runtime-capabilities'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../shared/antigravity-account-types'
import {
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from './runtime-client-target'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'

export async function callAntigravityAccounts(
  owner: RuntimeClientTarget,
  target: AntigravityAccountTarget,
  action: 'List' | 'AddCurrent' | 'Select' | 'Remove',
  accountId?: string
): Promise<AntigravityAccountState> {
  if (owner.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      owner.environmentId,
      ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
      'This execution host does not support native Antigravity Accounts yet. Update Orca on that host.'
    )
  }
  if (target.runtime === 'wsl') {
    const message =
      'This execution host does not support WSL Antigravity Accounts. Update Orca on the Windows host.'
    if (owner.kind === 'environment') {
      await assertRuntimeEnvironmentCapability(
        owner.environmentId,
        ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY,
        message
      )
    } else if (
      !(await ensureLocalRuntimeCapabilities())?.includes(
        ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY
      )
    ) {
      throw new Error(message)
    }
    if (action !== 'List' && !/^[a-f0-9]{64}$/.test(target.expectedAuthorityId ?? '')) {
      throw new Error('The WSL account target is not verified; reload Accounts before changing it.')
    }
  }
  const requestTarget =
    target.runtime === 'host'
      ? {
          runtime: target.runtime,
          ...(target.wslDistro === undefined ? {} : { wslDistro: target.wslDistro })
        }
      : target
  return callRuntimeRpc(
    owner,
    `accounts.antigravity${action}`,
    action === 'List' || action === 'AddCurrent'
      ? requestTarget
      : { target: requestTarget, accountId },
    { timeoutMs: 20_000 }
  )
}
