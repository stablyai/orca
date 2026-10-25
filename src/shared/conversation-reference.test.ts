import { describe, expect, it } from 'vitest'
import { deriveNativeChatRowContent } from './native-chat-row-content'
import {
  conversationReferenceToken,
  conversationReferenceUri,
  parseConversationReferenceUri,
  splitConversationReferences,
  withConversationReferenceInstructions,
  withoutConversationReferenceInstructions
} from './conversation-reference'

const uri = conversationReferenceUri('12345678-1234-4234-8234-123456789abc', 'runtime:build-host')

describe('conversation reference text', () => {
  it('preserves escaped titles, surrounding text, and multiple references', () => {
    const reference = { uri, title: 'Review [draft] \\ changes', agent: 'claude' }
    const token = conversationReferenceToken(reference)
    const parts = splitConversationReferences(`Compare ${token} with ${token}.`)
    expect(parts).toEqual([
      'Compare ',
      { ...reference, agent: '' },
      ' with ',
      { ...reference, agent: '' },
      '.'
    ])
    expect(parseConversationReferenceUri(uri)).toEqual({
      id: '12345678-1234-4234-8234-123456789abc',
      hostId: 'runtime:build-host'
    })
  })

  it('keeps malformed links literal and refuses paths or credentials', () => {
    expect(
      parseConversationReferenceUri('orca-conversation://reference/../../secret?host=local')
    ).toBeNull()
    expect(
      parseConversationReferenceUri(uri.replace('reference/', 'someone@reference/'))
    ).toBeNull()
    expect(
      splitConversationReferences('[bad](orca-conversation://reference/no-id?host=local)')
    ).toEqual(['[bad](orca-conversation://reference/no-id?host=local)'])
  })

  it('adds agent reading instructions only to messages with references and hides them again', () => {
    const prompt = `Use ${conversationReferenceToken({ uri, title: 'Earlier work', agent: 'codex' })}`
    const sent = withConversationReferenceInstructions(prompt)
    expect(sent).toContain('orca conversation read')
    expect(sent).toContain('orca conversation search')
    expect(withoutConversationReferenceInstructions(sent)).toBe(prompt)
    expect(deriveNativeChatRowContent([{ type: 'text', text: sent }]).markdown).toBe(prompt)
    expect(withConversationReferenceInstructions(sent)).toBe(sent)
    expect(withConversationReferenceInstructions('ordinary message')).toBe('ordinary message')
  })
})
