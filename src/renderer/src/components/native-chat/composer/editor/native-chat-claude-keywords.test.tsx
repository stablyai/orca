// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { claudeKeywords } from './native-chat-claude-keywords'

afterEach(cleanup)

// Tiptap hangs the editor on its contenteditable element.
function editorOf(container: HTMLElement): Editor {
  const editor: unknown = Reflect.get(within(container).getByRole('textbox'), 'editor')
  if (!(editor instanceof Editor)) {
    throw new Error('textbox has no Tiptap editor')
  }
  return editor
}

const words = (text: string) => claudeKeywords(text).map(({ word, rainbow }) => [word, rainbow])

describe('claudeKeywords', () => {
  it('finds the words Claude Code colors, in any case', () => {
    expect(words('UltraThink then ultraplan, and ultracode.')).toEqual([
      ['UltraThink', true],
      ['ultraplan', true],
      ['ultracode', false]
    ])
  })

  it('skips quoted, bracketed, tagged, path and flag uses, and slash commands', () => {
    for (const text of [
      'say `ultrathink` here',
      'the "ultracode" key',
      "the 'ultraplan' word",
      'see (ultrathink) or [ultracode] or {ultraplan}',
      'the <ultrathink> tag',
      'src/ultrathink and ultracode/x and pre-ultraplan and ultracode-y',
      'ultrathink? ultracode.ts',
      '/review ultrathink'
    ]) {
      expect(words(text), text).toEqual([])
    }
  })

  it('keeps a word after an apostrophe inside a sentence', () => {
    expect(words("don't stop, ultrathink")).toEqual([['ultrathink', true]])
  })
})

describe('NativeChatPromptEditor keyword coloring', () => {
  function mount(claudeKeywordsOn: boolean, initialValue = 'please ultrathink and ultracode') {
    const props = {
      inputRef: createRef<NativeChatComposerInput>(),
      initialValue,
      disabled: false,
      placeholder: 'Message',
      onChange: vi.fn(),
      onSelect: vi.fn()
    }
    const view = render(<NativeChatPromptEditor {...props} claudeKeywords={claudeKeywordsOn} />)
    const textbox = within(view.container).getByRole('textbox')
    const colored = () => [...textbox.querySelectorAll<HTMLElement>('[data-claude-keyword]')]
    return { view, props, colored }
  }

  it('colors each rainbow letter and the ultracode word only in a Claude chat', () => {
    const { view, props, colored } = mount(true)
    // 10 letters of ultrathink, one span for ultracode.
    expect(colored().map((span) => span.textContent)).toEqual([...'ultrathink', 'ultracode'])
    act(() => view.rerender(<NativeChatPromptEditor {...props} claudeKeywords={false} />))
    expect(colored()).toEqual([])
  })

  it('colors the right letters after a hard break and in a later paragraph', () => {
    const { view, colored } = mount(true)
    const editor = editorOf(view.container)
    act(() => {
      editor.commands.setContent('<p>go<br>ultracode</p><p>x ultraplan</p>')
    })
    expect(colored().map((span) => span.textContent)).toEqual(['ultracode', ...'ultraplan'])
  })

  it('reads the whole prompt: a quote across paragraphs and a side-chat command stay plain', () => {
    const { view, colored } = mount(true)
    const editor = editorOf(view.container)
    act(() => {
      editor.commands.setContent('<p>"quoted</p><p>ultrathink" then ultracode</p>')
    })
    expect(colored().map((span) => span.textContent)).toEqual(['ultracode'])
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'nativeChatSideChat', attrs: { token: '/btw ' } },
              { type: 'text', text: 'ultrathink' }
            ]
          }
        ]
      })
    })
    expect(colored()).toEqual([])
  })

  it('joins paragraphs like the submitted prompt, so an empty first paragraph is still a newline', () => {
    // An empty first paragraph, then a paragraph that looks like a slash command.
    const { props, colored } = mount(true, '\n/command ultrathink')
    // The editor's input value is promptText(doc): the text Claude receives.
    const submitted = props.inputRef.current?.value ?? ''
    expect(submitted).toBe('\n/command ultrathink')
    // The leading newline means the prompt is not a slash command, so the word is colored.
    const expected = claudeKeywords(submitted).flatMap(({ word, rainbow }) =>
      rainbow ? [...word] : [word]
    )
    expect(expected).toEqual([...'ultrathink'])
    expect(colored().map((span) => span.textContent)).toEqual(expected)
  })

  it('leaves other agents plain', () => {
    expect(mount(false).colored()).toEqual([])
  })
})
