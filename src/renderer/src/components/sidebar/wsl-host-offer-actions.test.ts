import { describe, expect, it, vi } from 'vitest'
import {
  acceptWslHostOffer,
  declineWslHostOffer,
  type WslHostOfferDeps
} from './wsl-host-offer-actions'

function deps(): WslHostOfferDeps {
  return {
    readWslHostsSetting: () => false,
    updateSettings: vi.fn(async () => undefined),
    addWslHost: vi.fn(async () => ({ ok: true as const, environmentId: 'wsl-ubuntu' })),
    addLocalPath: vi.fn(async () => ({ status: 'completed' })),
    moveAddedProject: vi.fn()
  }
}

const offer = {
  path: 'W:\\home\\u\\repo',
  sharePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo',
  distro: 'Ubuntu',
  source: 'local_folder_picker' as const
}

describe('WSL host offer on a distro-mapped drive', () => {
  it('adds the share spelling on accept, so the move can take it', async () => {
    const d = deps()
    await expect(acceptWslHostOffer(offer, d)).resolves.toBeNull()
    expect(d.addLocalPath).toHaveBeenCalledWith(offer.sharePath, offer.source)
    expect(d.moveAddedProject).toHaveBeenCalledWith(offer, { status: 'completed' })
  })

  it('adds the picked path unchanged on decline', async () => {
    const d = deps()
    await declineWslHostOffer(offer, d)
    expect(d.addLocalPath).toHaveBeenCalledWith(offer.path, offer.source)
  })
})
