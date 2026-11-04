import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { formatAgentImagePath } from './agent-image-paste'

describe('OMP image references', () => {
  it.each([
    `/tmp/a "both' quotes.png`,
    `/tmp/a "both' quotes/image.png`,
    `/tmp/a "both' @quotes#100%.png`,
    `/tmp/a "both' \\quotes.png`,
    `C:\\Images\\a "both' quotes.png`,
    `\\\\server\\share\\a "both' quotes.png`
  ])('round trips unquotable absolute paths through OMP file URLs: %s', (path) => {
    const mention = formatAgentImagePath('omp', path)
    const encodedPath = /^@"([^"]+)"$/.exec(mention)?.[1]
    expect(encodedPath).toBeDefined()
    expect(fileURLToPath(encodedPath!, { windows: !path.startsWith('/') })).toBe(path)
    expect(formatAgentImagePath('claude', path)).toBe(path)
  })
})
