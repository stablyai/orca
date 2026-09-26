import { describe, expect, it } from 'vitest'
import {
  terminalRichInputCanAttachImages,
  terminalRichInputInlineImageText
} from './terminal-rich-input-image-support'

describe('terminalRichInputCanAttachImages', () => {
  it('accepts images in ordinary terminal sessions', () => {
    expect(terminalRichInputCanAttachImages(null)).toBe(true)
  })

  it('supports native and file-reference image agents', () => {
    for (const agent of ['claude', 'codex', 'opencode', 'kimi', 'pi', 'grok'] as const) {
      expect(terminalRichInputCanAttachImages(agent)).toBe(true)
    }
    expect(terminalRichInputCanAttachImages('some-custom-agent')).toBe(false)
  })

  it('serializes inline image paths only for shell and file-reference agents', () => {
    expect(terminalRichInputInlineImageText(null, '/tmp/$(touch pwned).png', 'posix')).toBe(
      "'/tmp/$(touch pwned).png' "
    )
    expect(
      terminalRichInputInlineImageText(null, 'C:\\Users\\me\\design image.png', 'windows')
    ).toBe('"C:\\Users\\me\\design image.png" ')
    for (const agent of ['opencode', 'kimi', 'pi'] as const) {
      expect(terminalRichInputInlineImageText(agent, '/tmp/design image.png', 'posix')).toBe(
        '@"/tmp/design image.png" '
      )
    }
    expect(terminalRichInputInlineImageText('claude', '/tmp/image.png', 'posix')).toBeNull()
    expect(terminalRichInputInlineImageText('grok', '/tmp/image.png', 'posix')).toBeNull()
  })
})
