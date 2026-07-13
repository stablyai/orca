import { describe, expect, it } from 'vitest'
import { resolveWebChatCwdByAgent, WEBCHAT_DEFAULT_SUBDIR } from './web-chat-location'

describe('resolveWebChatCwdByAgent', () => {
  it('defaults each agent to workspaceDir/<source subfolder>', () => {
    const r = resolveWebChatCwdByAgent({}, '/home/u/orca/workspaces')
    expect(r).toEqual({
      chatgpt: '/home/u/orca/workspaces/ChatGPT',
      'claude-web': '/home/u/orca/workspaces/Claude',
      'gemini-web': '/home/u/orca/workspaces/Gemini'
    })
  })

  it('honors per-agent overrides, defaulting the rest', () => {
    const r = resolveWebChatCwdByAgent({ chatgpt: '/custom/gpt' }, '/w')
    expect(r.chatgpt).toBe('/custom/gpt')
    expect(r['gemini-web']).toBe('/w/Gemini')
  })

  it('ignores empty-string overrides (falls back to default)', () => {
    const r = resolveWebChatCwdByAgent({ 'claude-web': '' }, '/w')
    expect(r['claude-web']).toBe('/w/Claude')
  })

  it('exposes stable default subfolder names', () => {
    expect(WEBCHAT_DEFAULT_SUBDIR).toEqual({
      chatgpt: 'ChatGPT',
      'claude-web': 'Claude',
      'gemini-web': 'Gemini'
    })
  })

  it('uses the workspaceDir separator (Windows backslash)', () => {
    const r = resolveWebChatCwdByAgent({}, 'C:\\Users\\u\\orca\\workspaces')
    expect(r.chatgpt).toBe('C:\\Users\\u\\orca\\workspaces\\ChatGPT')
  })

  it('trims a trailing separator before joining', () => {
    expect(resolveWebChatCwdByAgent({}, '/w/').chatgpt).toBe('/w/ChatGPT')
  })
})
