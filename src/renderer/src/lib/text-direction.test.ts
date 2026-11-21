import { describe, expect, it } from 'vitest'
import { dominantTextDirection } from './text-direction'

describe('dominantTextDirection', () => {
  it.each([
    ['أنا أستخدم React و TypeScript في المشروع.', 'rtl'],
    ['React هو مكتبة لبناء الواجهات.', 'rtl'],
    ['Claude ممكن تساعدني في الكود؟', 'rtl'],
    ['I want to say مرحبا to the team.', 'ltr'],
    ['الملف src/main.ts فيه 3 أخطاء (errors).', 'rtl'],
    ['Plain English only.', 'ltr'],
    ['Hello,مرحبا،أهلا', 'rtl'],
    ['راجع src/main.ts و lib/app.ts', 'rtl']
  ] as const)('reads %s as %s', (text, direction) => {
    expect(dominantTextDirection(text)).toBe(direction)
  })

  it('gives a tie to the first word', () => {
    expect(dominantTextDirection('مرحبا hello')).toBe('rtl')
    expect(dominantTextDirection('hello مرحبا')).toBe('ltr')
  })

  it('has no direction without letters', () => {
    expect(dominantTextDirection('123 + 456 = ?')).toBeUndefined()
  })
})
