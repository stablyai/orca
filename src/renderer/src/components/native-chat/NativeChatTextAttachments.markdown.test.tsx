// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatTextAttachments } from './NativeChatTextAttachments'
import { NativeChatMarkdown } from './NativeChatMarkdown'
vi.mock('./NativeChatInlineVisual', () => ({ NativeChatInlineVisual: () => null }))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => null
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  isLocalizedRuntimeError: () => false
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))
vi.mock('./use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('./NativeChatMarkdownImage', async () => ({
  NativeChatMarkdownImage: () => null,
  NativeChatMarkdownImageLinkContext: (await import('react')).createContext(undefined)
}))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
afterEach(cleanup)
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
const renderText = (content: string) =>
  createElement(NativeChatMarkdown, { rowKey: 'architecture35636', content, variant: 'document' })
it('keeps original whole-body interpretation independent of exact lexical actions and terminal eligibility', async () => {
  const references = await import('../../../../shared/native-chat-text-attachment-references')
  const recognize = vi.spyOn(references, 'nativeChatTextAttachmentPaths')
  const content = `**Read @${path} then stop**\n\n\`\`\`text\n@${path}\nKEEP THIS CODE\n\`\`\`\n@${path.replace(/orca-paste-[^/]+$/, 'a&copy;.txt')}`
  {
    const direct = render(renderText(content))
    const expected = direct.container.innerHTML
    direct.unmount()
    const view = render(
      createElement(
        'div',
        null,
        createElement(NativeChatTextAttachments, {
          content,
          structured: true,
          renderText: (text) => createElement('div', { 'data-testid': 'body' }, renderText(text))
        })
      )
    )
    expect(view.getByTestId('body').innerHTML).toBe(expected)
    expect(view.container.querySelectorAll('button')).toHaveLength(
      references.nativeChatTextAttachmentPaths(content).length
    )
    view.unmount()
    recognize.mockClear()
    const terminal = render(
      createElement(NativeChatTextAttachments, { content, structured: false, renderText })
    )
    expect(terminal.container.innerHTML).toBe(expected)
    expect(recognize).not.toHaveBeenCalled()
    terminal.unmount()
  }
  expect(rpc).not.toHaveBeenCalled()
  const opened: string[] = []
  const { NativeChatTextAttachmentOpener } = await import('./NativeChatTextAttachments')
  const { formatNativeChatFileReference } = await import('../../../../shared/agent-image-paste')
  const exact = path.replace(/orca-paste-[^/]+$/, 'a&copy;.txt')
  const action = render(
    createElement(
      NativeChatTextAttachmentOpener.Provider,
      { value: (path) => opened.push(path) },
      createElement(NativeChatTextAttachments, {
        content: formatNativeChatFileReference(exact),
        structured: true,
        renderText
      })
    )
  )
  action.container.querySelector('button')!.click()
  expect(opened).toEqual([exact])
  recognize.mockRestore()
})
