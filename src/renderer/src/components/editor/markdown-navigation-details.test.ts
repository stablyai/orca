// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, expect, it } from 'vitest'
import { createOrcaDetailsExtensions } from './rich-markdown-details-extension'
import { revealMarkdownNavigationDetails } from './markdown-navigation-details'

const editors: Editor[] = []

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.innerHTML = ''
})

function detailsBlock(title: string, content: JSONContent[], variant = 'heading-2'): JSONContent {
  return {
    type: 'details',
    attrs: { open: false, variant },
    content: [
      { type: 'detailsSummary', content: [{ type: 'text', text: title }] },
      { type: 'detailsContent', content }
    ]
  }
}

function mountDetails(): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, ...createOrcaDetailsExtensions()],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep selection' }] },
        detailsBlock('Outer', [
          detailsBlock(
            'Inner',
            [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Target' }] }],
            'heading-3'
          )
        ]),
        detailsBlock('Sibling', [{ type: 'paragraph' }])
      ]
    }
  })
  editors.push(editor)
  return editor
}

it('opens only native details ancestors that conceal the destination', () => {
  document.body.innerHTML = `
    <details id="outer"><summary>Outer</summary>
      <details id="inner"><summary>Inner</summary><h2>Target</h2></details>
    </details>
    <details id="sibling"><summary>Sibling</summary></details>
  `
  revealMarkdownNavigationDetails(document.querySelector('h2')!)
  expect([...document.querySelectorAll('details')].map((details) => details.open)).toEqual([
    true,
    true,
    false
  ])
  document.querySelector('#inner')?.removeAttribute('open')
  document.querySelector('#outer')?.removeAttribute('open')
  revealMarkdownNavigationDetails(document.querySelector<HTMLElement>('#inner summary')!)
  expect([...document.querySelectorAll('details')].map((details) => details.open)).toEqual([
    true,
    false,
    false
  ])
})

it('opens rich ancestors in one undoable transaction while retaining selection and variants', () => {
  const editor = mountDetails()
  editor.commands.setTextSelection(2)
  const selection = editor.state.selection
  const text = editor.state.doc.textContent
  let transactions = 0
  editor.on('transaction', () => {
    transactions += 1
  })
  const heading = editor.view.dom.querySelector<HTMLElement>('h2')!

  revealMarkdownNavigationDetails(heading)

  expect(transactions).toBe(1)
  expect(editor.state.selection.eq(selection)).toBe(true)
  expect(editor.state.doc.textContent).toBe(text)
  expect(editor.state.doc.child(1).attrs).toMatchObject({ open: true, variant: 'heading-2' })
  expect(editor.state.doc.child(1).child(1).firstChild?.attrs).toMatchObject({
    open: true,
    variant: 'heading-3'
  })
  expect(editor.state.doc.child(2).attrs.open).toBe(false)
  expect(editor.view.dom.querySelector('[data-type="detailsContent"][hidden] h2')).toBeNull()
  revealMarkdownNavigationDetails(heading)
  expect(transactions).toBe(1)
  expect(editor.commands.undo()).toBe(true)
  expect(editor.state.doc.child(1).attrs.open).toBe(false)
  expect(editor.state.doc.child(1).child(1).firstChild?.attrs.open).toBe(false)
})

it('opens the outer rich fold without expanding a destination in its own summary', () => {
  const editor = mountDetails()
  revealMarkdownNavigationDetails(editor.view.dom.querySelectorAll<HTMLElement>('summary')[1])
  expect(editor.state.doc.child(1).attrs.open).toBe(true)
  expect(editor.state.doc.child(1).child(1).firstChild?.attrs.open).toBe(false)
  expect(editor.state.doc.child(2).attrs.open).toBe(false)
})

it.each([false, true])(
  'reveals readonly rich content without changing its document (open: %s)',
  (open) => {
    const editor = mountDetails()
    if (open) {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(editor.state.doc.firstChild!.nodeSize, undefined, {
          open: true,
          variant: 'heading-2'
        })
      )
    }
    editor.setEditable(false)
    if (open) {
      editor.view.dom.querySelector<HTMLButtonElement>('[data-type="details"] > button')?.click()
    }
    const doc = editor.state.doc
    let transactions = 0
    editor.on('transaction', () => {
      transactions += 1
    })
    const heading = editor.view.dom.querySelector<HTMLElement>('h2')!

    revealMarkdownNavigationDetails(heading)

    expect(editor.view.dom.querySelector('[data-type="detailsContent"][hidden] h2')).toBeNull()
    expect(editor.state.doc).toBe(doc)
    expect(editor.isFocused).toBe(false)
    expect(transactions).toBe(0)
    expect(editor.view.dom.querySelectorAll('[data-type="detailsContent"][hidden]')).toHaveLength(1)
    revealMarkdownNavigationDetails(heading)
    expect(editor.view.dom.querySelector('[data-type="detailsContent"][hidden] h2')).toBeNull()
    expect(transactions).toBe(0)
  }
)
