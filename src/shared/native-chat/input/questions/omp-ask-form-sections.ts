import {
  formClosest,
  formDescendants,
  formElementChildren,
  formPlainText,
  formTagSet,
  formTextContent,
  type FormMarkupElement,
  type FormMarkupNode
} from './omp-ask-form-markup'

type FormOption = { label: string; value: string; checked: boolean; disabled: boolean }
type FormField = {
  kind: 'choice' | 'text'
  name: string
  multi: boolean
  /** The control's own label; empty for radio/checkbox groups, whose question is the text around them. */
  label: string
  options: FormOption[]
  required: boolean
}
type FormBlock =
  | { kind: 'text'; text: string }
  | { kind: 'other' }
  | { kind: 'field'; field: FormField }
export type FormSection = { title: string; blocks: FormBlock[] }

// Tag roles as OMP's html-form parser treats them.
const SKIPPED = formTagSet('button head iframe link meta noscript script style template title')
const BLOCKS = formTagSet(
  'address article aside blockquote dd details div dl dt figure figcaption footer header li ' +
    'main nav p section h1 h2 h3 h4 h5 h6 summary'
)
const IGNORED_INPUTS = formTagSet('button file image reset submit hidden')

const isControl = (element: FormMarkupElement): boolean =>
  element.tag === 'input' || element.tag === 'select' || element.tag === 'textarea'

/** An element's text without the controls inside it; a picture reads as its alt text. */
function labelText(element: FormMarkupElement): string {
  const parts: string[] = []
  const visit = (node: FormMarkupNode): void => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (SKIPPED.has(node.tag) || isControl(node) || node.tag === 'svg') {
      return
    }
    if (node.tag === 'br' || BLOCKS.has(node.tag)) {
      parts.push(' ')
    }
    if (node.tag === 'img') {
      parts.push(node.attrs.alt ?? '')
    }
    node.children.forEach(visit)
  }
  element.children.forEach(visit)
  return formPlainText(parts.join(''))
}

/** Splits a form into sections of text blocks and fields, as OMP's html-form (v19.2.1) lays it out. */
export class OmpAskFormReader {
  readonly sections: FormSection[] = []
  private section: FormSection = { title: '', blocks: [] }
  private inline = ''
  private fieldsetDepth = 0
  /** Radio/checkbox groups by `type\0name`. */
  private readonly groups = new Map<string, FormField>()
  /** `<label for>` elements by the id of the control they name. */
  private readonly labelFor = new Map<string, FormMarkupElement>()
  /** Elements with a control inside, found once so nested lists and tables don't rescan their subtrees. */
  private readonly holdsControl = new Set<FormMarkupElement>()
  /** Label and cell texts, read once however many controls share them. */
  private readonly texts = new Map<FormMarkupElement, string>()

  constructor(root: FormMarkupElement) {
    this.sections.push(this.section)
    const controls = formDescendants(root, isControl)
    for (const control of controls) {
      for (let node = control.parent; node && !this.holdsControl.has(node); node = node.parent) {
        this.holdsControl.add(node)
      }
    }
    const ids = new Set(controls.map((control) => control.attrs.id))
    for (const label of formDescendants(root, (element) => element.tag === 'label')) {
      const target = label.attrs.for
      if (target && ids.has(target) && !this.labelFor.has(target)) {
        this.labelFor.set(target, label)
      }
    }
    root.children.forEach((child) => this.walk(child))
    this.flush()
  }

  private walk(node: FormMarkupNode): void {
    if (typeof node === 'string') {
      this.inline += node
      return
    }
    const tag = node.tag
    if (SKIPPED.has(tag)) {
      return
    }
    if (tag === 'br') {
      this.inline += ' '
    } else if (isControl(node)) {
      this.control(node, '')
    } else if (tag === 'label') {
      this.label(node)
    } else if (tag === 'fieldset') {
      this.fieldset(node)
    } else if (tag === 'ul' || tag === 'ol') {
      this.list(node)
    } else if (tag === 'table') {
      this.table(node)
    } else if (tag === 'pre' || tag === 'svg' || (tag === 'img' && node.attrs.src?.trim())) {
      this.flush()
      this.section.blocks.push({ kind: 'other' })
    } else if (tag === 'hr') {
      this.flush()
    } else if (tag === 'legend' || BLOCKS.has(tag)) {
      this.flush()
      node.children.forEach((child) => this.walk(child))
      this.flush()
    } else if (tag !== 'img') {
      node.children.forEach((child) => this.walk(child))
    }
  }

  /** Emit buffered inline content as a text block. */
  private flush(): void {
    const text = formPlainText(this.inline)
    this.inline = ''
    if (text) {
      this.section.blocks.push({ kind: 'text', text })
    }
  }

  private label(label: FormMarkupElement): void {
    const target = label.attrs.for
    if (target && this.labelFor.get(target) === label) {
      return
    }
    if (!this.holdsControl.has(label)) {
      label.children.forEach((child) => this.walk(child))
      return
    }
    this.flush()
    const text = this.textOf(label)
    formDescendants(label, isControl).forEach((control) => this.control(control, text))
  }

  private fieldset(fieldset: FormMarkupElement): void {
    this.flush()
    const legend = formElementChildren(fieldset).find((child) => child.tag === 'legend')
    if (this.fieldsetDepth > 0) {
      // Nested fieldsets stay in the outer section; their legend reads as a heading.
      if (legend) {
        this.walk(legend)
      }
    } else {
      this.startSection(legend ? labelText(legend) : '')
    }
    this.fieldsetDepth += 1
    for (const child of fieldset.children) {
      if (child !== legend) {
        this.walk(child)
      }
    }
    this.flush()
    this.fieldsetDepth -= 1
    if (this.fieldsetDepth === 0) {
      this.startSection('')
    }
  }

  private startSection(title: string): void {
    if (this.section.blocks.length === 0 && !this.section.title) {
      this.section.title = title
      return
    }
    this.section = { title, blocks: [] }
    this.sections.push(this.section)
  }

  private list(list: FormMarkupElement): void {
    this.flush()
    if (this.holdsControl.has(list)) {
      // A list of controls is layout, not content.
      list.children.forEach((child) => this.walk(child))
      this.flush()
      return
    }
    const items = formElementChildren(list).filter((child) => child.tag === 'li')
    if (items.some((item) => labelText(item))) {
      this.section.blocks.push({ kind: 'other' })
    }
  }

  private table(table: FormMarkupElement): void {
    this.flush()
    const rows = formDescendants(table, (element) => element.tag === 'tr')
      .filter((row) => formClosest(row, 'table') === table)
      .map((row) =>
        formElementChildren(row).filter((cell) => cell.tag === 'td' || cell.tag === 'th')
      )
    if (!this.holdsControl.has(table)) {
      if (rows.some((cells) => cells.length > 0)) {
        this.section.blocks.push({ kind: 'other' })
      }
      return
    }
    // A decision matrix: each row's text is a line; an unlabeled control borrows its column header.
    let header: string[] = []
    for (const cells of rows) {
      const controlsOf = cells.map((cell) =>
        this.holdsControl.has(cell) ? formDescendants(cell, isControl) : []
      )
      const noControls = controlsOf.every((controls) => controls.length === 0)
      if (noControls && cells.every((cell) => cell.tag === 'th')) {
        header = cells.map(labelText)
        continue
      }
      const text = cells
        .filter((_, column) => controlsOf[column]!.length === 0)
        .map((cell) => this.textOf(cell))
        .filter(Boolean)
        .join(' · ')
      if (text) {
        this.section.blocks.push({ kind: 'text', text })
      }
      cells.forEach((cell, column) => {
        for (const control of controlsOf[column]!) {
          const own = formClosest(control, 'label')
          // The control's label counts only inside this cell; a label around the table does not.
          const label = this.textOf(own && own !== formClosest(cell, 'label') ? own : cell)
          this.control(control, label || (header[column] ?? ''))
        }
      })
    }
  }

  private textOf(element: FormMarkupElement): string {
    const text = this.texts.get(element) ?? labelText(element)
    this.texts.set(element, text)
    return text
  }

  /** Label of a control outside any wrapping `<label>`: `<label for>`, then `aria-label`, `title`. */
  private detachedLabel(control: FormMarkupElement): string {
    const label = control.attrs.id ? this.labelFor.get(control.attrs.id) : undefined
    return label
      ? this.textOf(label)
      : formPlainText(control.attrs['aria-label'] ?? control.attrs.title ?? '')
  }

  private control(control: FormMarkupElement, wrapping: string): void {
    this.flush()
    const label = wrapping || this.detachedLabel(control)
    const name = control.attrs.name ?? ''
    const required = 'required' in control.attrs
    if (control.tag === 'select') {
      const options = formDescendants(control, (element) => element.tag === 'option').map(
        (option) => {
          const text = formPlainText(formTextContent(option))
          return {
            label: text,
            value: option.attrs.value ?? text,
            checked: 'selected' in option.attrs,
            disabled: 'disabled' in option.attrs
          }
        }
      )
      const multi = 'multiple' in control.attrs
      // A single select always has a selection: the first enabled option unless one is marked.
      if (!multi && !options.some((option) => option.checked)) {
        const first = options.find((option) => !option.disabled)
        if (first) {
          first.checked = true
        }
      }
      const field: FormField = { kind: 'choice', name, multi, label, options, required }
      this.section.blocks.push({ kind: 'field', field })
      return
    }
    const type =
      control.tag === 'textarea' ? 'textarea' : (control.attrs.type ?? 'text').toLowerCase()
    if (IGNORED_INPUTS.has(type)) {
      return
    }
    if (type !== 'radio' && type !== 'checkbox') {
      // A text field without a label is titled by its name: `sentry_dsn` reads `sentry dsn`.
      const ownLabel = label || formPlainText(name.replaceAll(/[_-]+/g, ' '))
      const field: FormField = {
        kind: 'text',
        name,
        multi: false,
        label: ownLabel,
        options: [],
        required
      }
      this.section.blocks.push({ kind: 'field', field })
      return
    }
    const value = control.attrs.value
    const option = {
      label: label || formPlainText(value ?? name),
      value: value ?? 'on',
      checked: 'checked' in control.attrs,
      disabled: 'disabled' in control.attrs
    }
    const key = `${type}\0${name}`
    const group = this.groups.get(key)
    if (group) {
      group.options.push(option)
      group.required ||= required
      return
    }
    const multi = type === 'checkbox'
    const field: FormField = { kind: 'choice', name, multi, label: '', options: [option], required }
    this.groups.set(key, field)
    this.section.blocks.push({ kind: 'field', field })
  }
}
