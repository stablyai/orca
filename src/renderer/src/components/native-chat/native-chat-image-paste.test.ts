import { describe, expect, it } from 'vitest'
import { getAgentImageHandling, resolveImagePaste } from './native-chat-image-paste'

describe('image paste agent map', () => {
  it('known image-capable agent attaches the temp file path', () => {
    expect(getAgentImageHandling('claude')).toBe('attachment')
    const result = resolveImagePaste('claude', '/tmp/orca-img-123.png')
    expect(result).toEqual({ kind: 'attach', path: '/tmp/orca-img-123.png' })
  })

  it('codex also attaches image paths', () => {
    expect(resolveImagePaste('codex', '/tmp/x.png')).toEqual({
      kind: 'attach',
      path: '/tmp/x.png'
    })
  })

  it('unknown/custom agent is unsupported', () => {
    expect(getAgentImageHandling('some-custom-agent')).toBe('unsupported')
    expect(resolveImagePaste('some-custom-agent', '/tmp/x.png')).toEqual({
      kind: 'unsupported',
      agent: 'some-custom-agent'
    })
  })
})
