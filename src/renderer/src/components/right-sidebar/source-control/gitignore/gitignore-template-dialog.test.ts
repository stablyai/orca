import { describe, expect, it } from 'vitest'
import { appendPreview } from './gitignore-template-dialog'

describe('appendPreview', () => {
  it('separates an existing file and template with one blank line', () => {
    expect(appendPreview('dist/\n', 'node_modules/\n')).toBe('dist/\n\nnode_modules/\n')
    expect(appendPreview('dist/', 'node_modules/\n')).toBe('dist/\n\nnode_modules/\n')
  })

  it('does not add a prefix for an empty file', () => {
    expect(appendPreview('', 'node_modules/\n')).toBe('node_modules/\n')
  })
})
