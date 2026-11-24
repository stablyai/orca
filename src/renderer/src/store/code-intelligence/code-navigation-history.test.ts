import { describe, expect, test } from 'vitest'
import { CodeNavigationHistory } from './code-navigation-history'

describe('CodeNavigationHistory', () => {
  test('records jumps across files and navigates back and forward', () => {
    let clock = 100
    const history = new CodeNavigationHistory(() => ++clock)

    history.recordJump(
      { filePath: '/repo/a.ts', line: 12, column: 5 },
      { filePath: '/repo/b.ts', line: 44, column: 17 }
    )
    expect(history.canGoBack()).toBe(true)
    expect(history.canGoForward()).toBe(false)
    expect(history.current?.filePath).toBe('/repo/b.ts')

    const back = history.back()
    expect(back?.filePath).toBe('/repo/a.ts')
    expect(back?.line).toBe(12)
    expect(history.canGoBack()).toBe(false)
    expect(history.canGoForward()).toBe(true)

    const fwd = history.forward()
    expect(fwd?.filePath).toBe('/repo/b.ts')
    expect(fwd?.line).toBe(44)
  })

  test('drops forward stack on new jump and merges nearby lines', () => {
    const history = new CodeNavigationHistory(() => 1)
    history.recordJump(
      { filePath: '/repo/a.ts', line: 10, column: 1 },
      { filePath: '/repo/a.ts', line: 12, column: 3 }
    )
    history.recordJump(
      { filePath: '/repo/a.ts', line: 12, column: 3 },
      { filePath: '/repo/c.ts', line: 90, column: 1 }
    )
    expect(history.entries).toHaveLength(2)

    history.back()
    expect(history.canGoForward()).toBe(true)
    history.recordJump(
      { filePath: '/repo/a.ts', line: 12, column: 3 },
      { filePath: '/repo/d.ts', line: 3, column: 1 }
    )
    expect(history.canGoForward()).toBe(false)
    expect(history.current?.filePath).toBe('/repo/d.ts')
  })
})
