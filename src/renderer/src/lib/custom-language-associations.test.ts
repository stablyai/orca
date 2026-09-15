import { afterEach, describe, expect, it } from 'vitest'
import { setCustomLanguageAssociations } from './custom-language-associations'
import { detectLanguage } from './language-detect'

afterEach(() => setCustomLanguageAssociations([]))
describe('custom language associations', () => {
  it('matches exact names before compound suffixes on Windows and Unix paths', () => {
    setCustomLanguageAssociations([
      { id: 'examplelang', scopeName: 'source.examplelang', extensions: ['.examplelang'] },
      { id: 'template', scopeName: 'source.template', extensions: ['.test.examplelang'] },
      { id: 'special', scopeName: 'source.special', filenames: ['exact.test.examplelang'] }
    ])
    expect(detectLanguage('/repo/code.EXAMPLELANG')).toBe('examplelang')
    expect(detectLanguage('C:\\repo\\code.test.examplelang')).toBe('template')
    expect(detectLanguage('/repo/exact.test.examplelang')).toBe('special')
    expect(detectLanguage('/repo/exact.TEST.EXAMPLELANG')).toBe('template')
    expect(detectLanguage('/repo/code.ts')).toBe('typescript')
  })

  it('allows custom associations to override built-in associations, with first entry winning', () => {
    setCustomLanguageAssociations([
      { id: 'custom', scopeName: 'source.custom', extensions: ['.ts'], filenames: ['Dockerfile'] },
      { id: 'later', scopeName: 'source.later', extensions: ['.ts'] }
    ])
    expect(detectLanguage('code.ts')).toBe('custom')
    expect(detectLanguage('Dockerfile')).toBe('custom')
    setCustomLanguageAssociations([])
    expect(detectLanguage('code.ts')).toBe('typescript')
    expect(detectLanguage('Dockerfile')).toBe('dockerfile')
  })
})
