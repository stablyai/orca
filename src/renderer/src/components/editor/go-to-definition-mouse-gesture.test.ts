import { describe, expect, it } from 'vitest'
import { isGoToDefinitionMouseGesture } from './go-to-definition-mouse-gesture'

const macPrimaryClick = {
  platform: 'darwin' as const,
  metaKey: true,
  ctrlKey: false,
  leftButton: true,
  contentText: true,
  hasPosition: true
}

describe('isGoToDefinitionMouseGesture', () => {
  it('accepts the platform modifier with a primary content click', () => {
    expect(isGoToDefinitionMouseGesture(macPrimaryClick)).toBe(true)
    expect(
      isGoToDefinitionMouseGesture({
        ...macPrimaryClick,
        platform: 'win32',
        metaKey: false,
        ctrlKey: true
      })
    ).toBe(true)
  })

  it('rejects modifier-right-click', () => {
    expect(isGoToDefinitionMouseGesture({ ...macPrimaryClick, leftButton: false })).toBe(false)
  })
})
