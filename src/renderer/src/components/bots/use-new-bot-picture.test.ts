// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useNewBotPicture } from './use-new-bot-picture'

const shared = { color: '#f4c4cf', outfit: 'tie' as const }

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
})
