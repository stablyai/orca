import { describe, expect, it } from 'vitest'
import { splitNativeChatSessionContext } from './native-chat-context-disclosure'

describe('splitNativeChatSessionContext', () => {
  it('keeps the human prompt visible and moves injected context into disclosure', () => {
    const result = splitNativeChatSessionContext(
      '<user_info>account metadata</user_info>\n\nPlease fix the titlebar.\n\n<environment_context>repo metadata</environment_context>'
    )

    expect(result.visibleText).toBe('Please fix the titlebar.')
    expect(result.contextSectionCount).toBe(2)
    expect(result.contextText).toContain('<user_info>account metadata</user_info>')
    expect(result.contextText).toContain('<environment_context>repo metadata</environment_context>')
  })

  it('leaves ordinary user prose unchanged', () => {
    const text = 'Explain why `<user_info>` appears in this string.'
    expect(splitNativeChatSessionContext(text)).toEqual({
      visibleText: text,
      contextText: '',
      contextSectionCount: 0
    })
  })

  it('supports the app context tags used by desktop sessions', () => {
    const result = splitNativeChatSessionContext(
      '<app-context>desktop state</app-context><skills_instructions>skills</skills_instructions>'
    )

    expect(result.visibleText).toBe('')
    expect(result.contextSectionCount).toBe(2)
  })

  it('folds the provider rules preamble when it only introduces context sections', () => {
    const result = splitNativeChatSessionContext(
      'The rules section has a number of possible rules/memories/context that you should consider.\nIn each subsection, we provide instructions about what information the subsection contains\nand how you should consider/follow the contents of the subsection.\n\n<user_rules>rules</user_rules>'
    )

    expect(result.visibleText).toBe('')
    expect(result.contextSectionCount).toBe(1)
  })
})
