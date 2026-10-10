import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve('src/renderer/src/components/native-chat/native-chat-appearance.css'),
  'utf8'
)
const rootRule = /\.native-chat-appearance \{([^}]*)\}/.exec(css)?.[1] ?? ''

function declared(name: string): string {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(rootRule)?.[1] ?? ''
}

describe('chat type scale', () => {
  it('sizes the reading step from the text size setting', () => {
    expect(declared('--text-sm')).toContain('var(--chat-font-size')
  })

  // A step that stops deriving from --text-sm stays fixed while the setting moves the rest.
  it.each(['--text-xs', '--text-2xs', '--text-3xs'])('scales %s with the reading step', (step) => {
    expect(declared(step)).toContain('var(--text-sm)')
  })

  it('scales spacing and icons with the reading step', () => {
    expect(declared('--spacing')).toContain('var(--text-sm)')
  })

  it('sizes code from the code text size setting', () => {
    expect(declared('--text-chat-code')).toContain('var(--chat-code-font-size')
  })
})
