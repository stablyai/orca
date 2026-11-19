import { describe, expect, it } from 'vitest'
import { isGeneratedCustom, pictureFaceOrder } from './bot-picture-face-order'

describe('pictureFaceOrder', () => {
  it('puts Generate just before mascot 1 and the custom picture after its mascot', () => {
    const order = pictureFaceOrder(1, true)
    expect(order.slice(0, 5)).toEqual(['generate', 'A1', 'B1', 'custom', 'D1'])
  })

  it('has no Generate face without a capable agent', () => {
    expect(pictureFaceOrder(null, false).slice(0, 2)).toEqual(['A1', 'B1'])
  })
})

describe('isGeneratedCustom', () => {
  it('matches the applied generated picture, not another upload', () => {
    expect(isGeneratedCustom('data:image/png;base64,QUJD', 'QUJD')).toBe(true)
    expect(isGeneratedCustom('data:image/png;base64,WFla', 'QUJD')).toBe(false)
    expect(isGeneratedCustom('data:image/png;base64,QUJD', null)).toBe(false)
  })
})
