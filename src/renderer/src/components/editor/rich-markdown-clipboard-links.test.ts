// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  setRichMarkdownImageResolverContext,
  type RichMarkdownImageRuntimeContext
} from './rich-markdown-image-context'
import { resolveMarkdownPreviewHref } from './markdown-preview-links'

const editors: Editor[] = []

function workspace(
  worktreePath: string,
  overrides: Partial<RichMarkdownImageRuntimeContext> = {}
): RichMarkdownImageRuntimeContext {
  return { target: { kind: 'local' }, worktreeId: `wt:${worktreePath}`, worktreePath, ...overrides }
}

function createEditor(
  filePath: string,
  href = './guide.md',
  runtimeContext: RichMarkdownImageRuntimeContext | undefined = workspace('/repo')
): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: `Before **[guide](${href} "Reference")** after.`,
    contentType: 'markdown'
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath, runtimeContext })
  return editor
}
function copy(editor: Editor): string {
  editor.commands.selectAll()
  return editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
}
function paste(editor: Editor, html: string): void {
  editor.commands.selectAll()
  editor.view.pasteHTML(html)
}
function href(editor: Editor): string | null {
  return editor.view.dom.querySelector('a')?.getAttribute('href') ?? null
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

it('rebases a relative link pasted into a note in another folder of the same workspace', () => {
  const source = createEditor('/repo/notes/note.md')
  const html = copy(source)
  source.destroy()
  const target = createEditor('/repo/other/note.md', 'https://example.com')
  paste(target, html)
  expect(href(target)).toBe('../notes/guide.md')
  expect(target.view.dom.querySelector('a')?.getAttribute('title')).toBe('Reference')
  const markdown = target.getMarkdown()
  expect(markdown).toContain('[**guide**](../notes/guide.md "Reference")')
  expect(markdown).not.toContain('clipboard-origin')
})

it.each([
  [
    '/repo/notes/note.md',
    '/repo/other/note.md',
    './a%20b%23c.md?version=2#part',
    '../notes/a%20b%23c.md?version=2#part'
  ],
  ['C:\\repo\\notes\\note.md', 'C:\\repo\\other\\note.md', './guide.md', '../notes/guide.md']
])('keeps the resolved target from %s into %s for %s', (from, to, link, expected) => {
  const root = from.startsWith('C:') ? 'C:\\repo' : '/repo'
  const source = createEditor(from, link, workspace(root))
  const target = createEditor(to, './old.md', workspace(root))
  paste(target, copy(source))
  expect(href(target)).toBe(expected)
  expect(resolveMarkdownPreviewHref(href(target) ?? '', to)?.toString()).toBe(
    resolveMarkdownPreviewHref(link, from)?.toString()
  )
})

it('keeps the relative spelling within the same folder', () => {
  const source = createEditor('/repo/notes/note.md')
  const target = createEditor('/repo/notes/second.md')
  paste(target, copy(source))
  expect(href(target)).toBe('./guide.md')
})

it('keeps the relative spelling between sibling worktrees of the same repo', () => {
  const source = createEditor('/ws/A/notes/note.md', './guide.md', workspace('/ws/A'))
  const target = createEditor('/ws/B/notes/note.md', './old.md', workspace('/ws/B'))
  paste(target, copy(source))
  expect(href(target)).toBe('./guide.md')
})

it('does not rebase a link whose target leaves the workspace root', () => {
  const source = createEditor('/repo/notes/note.md', '../../outside.md')
  const target = createEditor('/repo/other/deeper/note.md')
  paste(target, copy(source))
  expect(href(target)).toBe('../../outside.md')
})

it('does not rebase between different runtime owners', () => {
  const source = createEditor('/repo/notes/note.md', './guide.md', workspace('/repo'))
  const target = createEditor(
    '/repo/other/note.md',
    './old.md',
    workspace('/repo', { target: { kind: 'environment', environmentId: 'remote' } })
  )
  paste(target, copy(source))
  expect(href(target)).toBe('./guide.md')
})

it('ignores origin metadata that does not match the copied href', () => {
  const source = createEditor('/repo/notes/note.md')
  const html = copy(source).replace('href="./guide.md"', 'href="./different.md"')
  const target = createEditor('/repo/other/note.md')
  paste(target, html)
  expect(href(target)).toBe('./different.md')
})
