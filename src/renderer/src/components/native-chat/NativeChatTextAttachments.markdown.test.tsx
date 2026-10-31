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
  const contents = [
    `Literal:\n\n\`\`\`text\n@${path}\nKEEP THIS CODE\n\`\`\`\n\nOUTSIDE CODE`,
    `\` @${path} \``,
    `    @${path}\n`,
    `> - \` @${path} \``,
    `**Read @${path} then stop**`,
    `\\*escaped* @${path} `,
    `see@${path.replace(/orca-paste-[^/]+$/, 'a&copy;.txt')} `,
    `@${path.replace(/orca-paste-[^/]+$/, 'a`b.txt')} @${path.replace(/orca-paste-[^/]+$/, 'c`d.txt')} `,
    `\` @${path}\``
  ]
  for (const content of contents) {
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
  recognize.mockRestore()
})

it('recognizes only changed rows at N and 10N without reading attachment bodies before open', async () => {
  const references = await import('../../../../shared/native-chat-text-attachment-references')
  const recognize = vi.spyOn(references, 'nativeChatTextAttachmentPaths')
  const renderText = (text: string) => createElement('span', null, text)
  for (const count of [10, 100]) {
    let rows = Array.from(
      { length: count },
      (_, index) => `row ${index} **Read @${path} then stop** ${'prose '.repeat(100)}`
    )
    const ui = () =>
      rows.map((content, index) =>
        createElement(NativeChatTextAttachments, {
          key: index,
          content,
          structured: true,
          renderText
        })
      )
    recognize.mockClear()
    const view = render(ui())
    expect(recognize).toHaveBeenCalledTimes(count)
    recognize.mockClear()
    for (let update = 0; update < 3; update++) {
      view.rerender(ui())
    }
    expect(recognize).not.toHaveBeenCalled()
    rows = rows.map((content, index) => (index === 0 ? `${content}changed` : content))
    view.rerender(ui())
    expect(recognize).toHaveBeenCalledTimes(1)
    view.unmount()
  }
  expect(rpc).not.toHaveBeenCalled()
  recognize.mockRestore()
})

it('opens original descriptor-less POSIX, Windows and UNC tokens without entity, escape or punctuation normalization', async () => {
  const { formatNativeChatFileReference } = await import('../../../../shared/agent-image-paste')
  const { NativeChatTextAttachmentOpener } = await import('./NativeChatTextAttachments')
  const uuid = '12345678-1234-1234-1234-123456789abc'
  const paths = [
    `/root/agent-session-attachments/${uuid}/normal.txt`,
    `/root [@] ' " (x)/agent-session-attachments/${uuid}/_notes_.txt`,
    `/root/agent-session-attachments/${uuid}/a&copy;.txt`,
    `/root/agent-session-attachments/${uuid}/a©.txt`,
    `/root/agent-session-attachments/${uuid}/a\`b\`.txt`,
    `/root/agent-session-attachments/${uuid}/literal.txt\``,
    `/root/agent-session-attachments/${uuid}/literal.txt)`,
    `C:\\Orca data\\agent-session-attachments\\${uuid}\\brackets[1](2).txt`,
    `\\\\server\\root @ ' "\\agent-session-attachments\\${uuid}\\日本語.txt`
  ]
  const opened: string[] = []
  const content = [
    ...paths.map(formatNativeChatFileReference),
    '@/workspace/file.txt',
    `@/root/agent-session-attachments/${uuid}/.upload.part`
  ].join(' ')
  const view = render(
    createElement(
      NativeChatTextAttachmentOpener.Provider,
      { value: (path) => opened.push(path) },
      createElement(NativeChatTextAttachments, { content, structured: true, renderText })
    )
  )
  view.container.querySelectorAll('button').forEach((button) => button.click())
  expect(opened).toEqual(paths)
  view.unmount()
})
