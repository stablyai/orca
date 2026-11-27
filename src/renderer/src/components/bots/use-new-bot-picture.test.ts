// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import {
  invalidateAvatarPackCatalogCache,
  resolveAvatarPackAnimationFile
} from './avatar-packs/avatar-pack-catalog'
import type { AvatarPackCatalogIndex } from './avatar-packs/avatar-pack-types'
import { useNewBotPicture } from './use-new-bot-picture'

const shared = { color: '#f4c4cf', outfit: 'tie' as const }

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ settings: null })
  invalidateAvatarPackCatalogCache()
})

describe('a new bot from a shared mascot', () => {
  it("is made on the sharer's tile color and outfit", () => {
    const { result } = renderHook(() =>
      useNewBotPicture({ colors: true, outfits: true }, 'H1', undefined, shared)
    )
    expect(result.current).toMatchObject({
      avatar: 'mascot:H1',
      avatarColor: '#f4c4cf',
      avatarOutfit: 'tie'
    })
  })

  it('leaves off what the host cannot store', () => {
    const { result } = renderHook(() =>
      useNewBotPicture({ colors: true, outfits: false }, 'H1', undefined, shared)
    )
    expect(result.current.avatarColor).toBe('#f4c4cf')
    expect(result.current.avatarOutfit).toBeUndefined()
  })

  it("keeps an outfit this version doesn't draw, for a newer Orca", () => {
    const { result } = renderHook(() =>
      useNewBotPicture({ colors: true, outfits: true }, 'H1', undefined, { outfit: 'aviator' })
    )
    expect(result.current.outfit).toBeNull()
    expect(result.current.avatarOutfit).toBe('aviator')
  })

  it('clamps animated pack indices to actual character counts and reloads on catalog invalidation', async () => {
    const smallCatalog: AvatarPackCatalogIndex = {
      stickers: {
        manifest: {
          v: 1,
          id: 'stickers',
          version: 1,
          minApp: '1.0.0',
          rig: 'face',
          bodyFill: 0.7,
          characters: []
        },
        characters: {
          '0': { idle: [{ variant: 0, file: '0_idle.json' }] },
          '1': { idle: [{ variant: 0, file: '1_idle.json' }] },
          '2': { idle: [{ variant: 0, file: '2_idle.json' }] }
        }
      }
    }
    const updatedCatalog: AvatarPackCatalogIndex = {
      chromahair: {
        manifest: {
          v: 1,
          id: 'chromahair',
          version: 1,
          minApp: '1.0.0',
          rig: 'face',
          bodyFill: 0.8,
          characters: []
        },
        characters: {
          '0': { idle: [{ variant: 0, file: 'chroma_0.json' }] }
        }
      }
    }

    let servedCatalog: AvatarPackCatalogIndex = smallCatalog
    const originalFetch = globalThis.fetch
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('orca-avatar-pack://')) {
        return new Response(JSON.stringify(servedCatalog), { status: 200 })
      }
      return originalFetch(input, init)
    }
    vi.stubGlobal('fetch', mockFetch)
    window.fetch = mockFetch

    expect(resolveAvatarPackAnimationFile(smallCatalog, 'stickers', 19, 'idle')).toBe('1_idle.json')

    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/fixture'),
        avatarPacksEnabled: true,
        avatarDefaultPack: 'stickers'
      }
    })

    const { result } = renderHook(() => useNewBotPicture({ colors: true, outfits: true }))

    await waitFor(() => {
      expect(result.current.animatedAvatar).toMatch(/^mascot:pack\/stickers\/[012]$/)
    })
    expect(result.current.avatar).toBe(result.current.animatedAvatar)
    expect(result.current.avatarColor).toBeUndefined()
    expect(result.current.avatarOutfit).toBeUndefined()

    act(() => {
      result.current.setAnimatedAvatar('mascot:pack/stickers/19')
    })
    expect(result.current.animatedAvatar).toBe('mascot:pack/stickers/1')

    servedCatalog = updatedCatalog
    act(() => {
      result.current.reset()
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/fixture'),
          avatarPacksEnabled: true,
          avatarDefaultPack: 'stickers',
          avatarPacksDir: '/tmp/custom-packs'
        }
      })
    })

    await waitFor(() => {
      expect(result.current.animatedAvatar).toBe('mascot:pack/chromahair/0')
    })
  })
})
