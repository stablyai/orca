import { describe, expect, it } from 'vitest'
import { getCodeFenceLanguageLabel } from './code-fence-language-label'

describe('getCodeFenceLanguageLabel', () => {
  it.each([
    ['typescript', 'TypeScript'],
    ['ts', 'TypeScript'],
    ['py', 'Python'],
    ['bash', 'Bash'],
    ['yml', 'YAML'],
    ['vue', 'Vue'],
    ['tsx', 'TSX'],
    ['ps1', 'PowerShell'],
    ['Python', 'Python']
  ])('names ```%s as %s', (tag, label) => {
    expect(getCodeFenceLanguageLabel(tag)).toBe(label)
  })

  it('keeps a tag the catalogue does not know as written', () => {
    expect(getCodeFenceLanguageLabel('my-dsl')).toBe('my-dsl')
  })
})
