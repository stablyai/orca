import { expect, it } from 'vitest'
import { accountOwnerFor } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import { isOwnerReturnToLocal } from './owner-usage-rate-limits'

it('treats only a remote-to-local owner change as a return to this device', () => {
  const local = accountOwnerFor({ kind: 'local' }, null)
  const remote = accountOwnerFor({ kind: 'environment', environmentId: 'mini' }, null)
  const otherRemote = accountOwnerFor({ kind: 'environment', environmentId: 'studio' }, null)
  const wsl = accountOwnerFor({ kind: 'environment', environmentId: 'wsl' }, 'Ubuntu')

  expect(isOwnerReturnToLocal(remote, local)).toBe(true)
  expect(isOwnerReturnToLocal(local, local)).toBe(false)
  expect(isOwnerReturnToLocal(local, remote)).toBe(false)
  expect(isOwnerReturnToLocal(remote, otherRemote)).toBe(false)
  expect(isOwnerReturnToLocal(remote, null)).toBe(false)
  expect(isOwnerReturnToLocal(null, local)).toBe(false)
  expect(isOwnerReturnToLocal(remote, wsl)).toBe(false)
  expect(isOwnerReturnToLocal(wsl, local)).toBe(false)
})
