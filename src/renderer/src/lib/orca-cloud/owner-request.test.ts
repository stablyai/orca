import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ access: vi.fn(), clipboard: vi.fn() }))
vi.mock('./use-orca-cloud-repo-access', () => ({ fetchOrcaCloudRepoAccess: mocks.access }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { translate } from '@/i18n/i18n'
import { copyOwnerRequest, ownerRequestLabel } from './owner-request'

const REPO_URL = 'https://github.com/stablyai/orca-plugins'

describe('Copy request for an owner (REQUEST-COPY-SHARE)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { ui: { writeClipboardText: mocks.clipboard } } }
    })
  })
  afterEach(() => {
    mocks.access.mockReset()
    mocks.clipboard.mockReset()
  })

  it('names the repository and what the access is for, with the install link that preselects it', async () => {
    mocks.access.mockResolvedValue({
      access: 'requested',
      installUrl: 'https://github.com/apps/orca/install'
    })
    await expect(copyOwnerRequest(REPO_URL, 'start')).resolves.toBe(true)
    const [start] = mocks.clipboard.mock.calls[0] ?? []
    expect(start).toContain('stablyai/orca-plugins')
    expect(start).toContain('start workspaces from this repository')
    expect(start).toContain('https://github.com/apps/orca/install')
    await copyOwnerRequest(REPO_URL, 'push')
    const [push] = mocks.clipboard.mock.calls[1] ?? []
    expect(push).toContain('push from workspaces on this repository')
  })

  it('without an install link the message still goes; a clipboard failure says so', async () => {
    mocks.access.mockResolvedValue(null)
    await copyOwnerRequest(REPO_URL, 'push')
    expect(mocks.clipboard.mock.calls[0]?.[0]).not.toContain('\n')
    mocks.clipboard.mockRejectedValueOnce(new Error('no clipboard'))
    await expect(copyOwnerRequest(REPO_URL, 'push')).resolves.toBe(false)
  })

  it('one label for both surfaces, Copied for a moment after', () => {
    expect(ownerRequestLabel(false, translate)).toBe('Copy request for an owner')
    expect(ownerRequestLabel(true, translate)).toBe('Copied')
  })
})
