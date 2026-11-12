import { monaco } from '@/lib/editor/monaco/monaco-setup'
import type { editor } from 'monaco-editor'
import type { CombinedDiffViewportOwner, DiffViewportItem } from './combined-diff-viewport-owner'

export type RetainedDiffItem = {
  readonly model: editor.IDiffEditorModel
  readonly viewModel: editor.IIndependentDiffEditorViewModel
  viewState: editor.IDiffEditorViewState | null
}
export type DiffEditorTemplate = {
  readonly editor: editor.IStandaloneDiffEditor
  readonly node: HTMLDivElement
  readonly overflow: HTMLDivElement
}

let nextOwnerId = 0
const pools = new WeakMap<CombinedDiffViewportOwner, CombinedDiffEditorPool>()

export function combinedDiffEditorPool(owner: CombinedDiffViewportOwner): CombinedDiffEditorPool {
  let pool = pools.get(owner)
  if (!pool) {
    pool = new CombinedDiffEditorPool(owner)
    pools.set(owner, pool)
  }
  return pool
}

class CombinedDiffEditorPool {
  private readonly id = ++nextOwnerId
  private readonly spares: DiffEditorTemplate[] = []
  private readonly active = new Set<DiffEditorTemplate>()
  private readonly records = new Map<DiffViewportItem, RetainedDiffItem>()

  constructor(private readonly owner: CombinedDiffViewportOwner) {
    owner.onDispose.add(() => this.dispose())
  }

  acquire(options: editor.IDiffEditorConstructionOptions): DiffEditorTemplate {
    let template = this.spares.pop()
    if (!template) {
      const node = document.createElement('div')
      const overflow = document.createElement('div')
      overflow.className = 'monaco-editor'
      template = {
        node,
        overflow,
        editor: monaco.editor.createDiffEditor(node, {
          ...options,
          automaticLayout: false,
          allowOverflow: true,
          fixedOverflowWidgets: true,
          overflowWidgetsDomNode: overflow
        })
      }
    }
    this.active.add(template)
    this.owner.overflow.append(template.overflow)
    return template
  }

  item(
    item: DiffViewportItem,
    template: DiffEditorTemplate,
    contents: { original: string; modified: string; language: string },
    options: editor.IDiffEditorConstructionOptions,
    width: number
  ): RetainedDiffItem {
    const existing = this.records.get(item)
    if (existing) {
      return existing
    }
    const base = `combined-diff:${this.id}:${encodeURIComponent(item.key)}:${item.generation}`
    const model = {
      original: monaco.editor.createModel(
        contents.original,
        contents.language,
        monaco.Uri.parse(`${base}:original`)
      ),
      modified: monaco.editor.createModel(
        contents.modified,
        contents.language,
        monaco.Uri.parse(`${base}:modified`)
      )
    }
    const viewModel = template.editor.createIndependentViewModel(model, options, width)
    const record = { model, viewModel, viewState: null }
    this.records.set(item, record)
    item.onRetire.add(() => {
      this.records.delete(item)
      viewModel.dispose()
      model.original.dispose()
      model.modified.dispose()
    })
    return record
  }

  release(template: DiffEditorTemplate): void {
    if (!this.active.delete(template)) {
      return
    }
    template.editor.setModel(null)
    template.node.remove()
    template.overflow.remove()
    if (this.spares.length < 5) {
      this.spares.push(template)
    } else {
      template.editor.dispose()
    }
  }

  private dispose(): void {
    for (const template of [...this.active, ...this.spares]) {
      template.editor.dispose()
      template.node.remove()
      template.overflow.remove()
    }
    this.active.clear()
    this.spares.length = 0
  }
}
