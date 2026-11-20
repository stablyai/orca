import { describe, expect, it } from 'vitest'
import { isGeneratedCustom, pictureFaceOrder } from './bot-picture-face-order'

describe('pictureFaceOrder', () => {
  it('puts Generate just left of the mascot selected at open', () => {
    const order = pictureFaceOrder(1, { before: 'mascot', index: 3 })
    expect(order.slice(0, 6)).toEqual(['A1', 'B1', 'custom', 'D1', 'generate', 'E1'])
  })

  it('puts Generate just left of a custom picture selected at open', () => {
    const order = pictureFaceOrder(1, { before: 'custom', after: 1 })
    expect(order.slice(0, 5)).toEqual(['A1', 'B1', 'generate', 'custom', 'D1'])
  })

  it('keeps Generate in its place once that custom picture is gone', () => {
    const order = pictureFaceOrder(null, { before: 'custom', after: 1 })
    expect(order.slice(0, 4)).toEqual(['A1', 'B1', 'generate', 'D1'])
  })
})

describe('isGeneratedCustom', () => {
  it('matches the applied generated picture, not another upload', () => {
    expect(isGeneratedCustom('data:image/png;base64,QUJD', 'QUJD')).toBe(true)
    expect(isGeneratedCustom('data:image/png;base64,WFla', 'QUJD')).toBe(false)
    expect(isGeneratedCustom('data:image/png;base64,QUJD', null)).toBe(false)
  })
})
