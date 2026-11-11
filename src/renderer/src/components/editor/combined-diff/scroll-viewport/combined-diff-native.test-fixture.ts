import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { CombinedDiffNativeBinding } from './combined-diff-native-binding'
import { CombinedDiffViewportOwner } from './combined-diff-viewport-owner'
import type { RetainedDiffItem } from './combined-diff-editor-pool'

export async function nativeCommit(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

export async function createNativeBindingFixture(transform = 0) {
  const owner = new CombinedDiffViewportOwner()
  const host = document.createElement('div')
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } })
  Object.defineProperty(owner.root, 'clientHeight', { value: 500 })
  document.body.append(host)
  const unmount = owner.mount(host)
  owner.setItems([{ key: 'long.ts', generation: '1', height: 3000, collapsed: false, index: 0 }])
  await nativeCommit()
  const item = owner.getItem('long.ts')!
  const row = document.createElement('div')
  const header = document.createElement('div')
  const body = document.createElement('div')
  Object.defineProperty(header, 'offsetHeight', { value: 28 })
  row.append(header, body)
  owner.scene.append(row)
  item.chrome = { header, conflict: null, body }
  owner.setNode(item, row)
  const text = Array.from({ length: 160 }, (_, index) => `line ${index}`).join('\n')
  const originalModel = monaco.editor.createModel(text, 'plaintext')
  const modifiedModel = monaco.editor.createModel(text, 'plaintext')
  const zone = { id: 'own-zone', top: 1400, height: 152, hidden: false }
  let nativeHeight = 453
  let horizontal = false
  let mappingShift = 0
  let originalOffset = 0
  let modifiedOffset = transform
  const lifecycle: string[] = []
  const listeners = new Map<string, Set<() => void>>()
  function event(key: string, listener: () => void) {
    let entries = listeners.get(key)
    if (!entries) {
      entries = new Set()
      listeners.set(key, entries)
    }
    entries.add(listener)
    return { dispose: () => entries.delete(listener) }
  }
  function fire(key: string): void {
    for (const listener of listeners.get(key) ?? []) {
      listener()
    }
  }
  let reveal: ((request: editor.ISemanticViewRevealRequest) => void) | undefined
  function pane(original: boolean): editor.ICodeEditor {
    const model = original ? originalModel : modifiedModel
    const value = {
      getModel: () => model,
      getContainerDomNode: () => body,
      getLayoutInfo: () => ({ height: nativeHeight, contentWidth: 760 }),
      getScrollWidth: () => (horizontal ? 900 : 760),
      getScrollHeight: () => 2953 + zone.height - 152,
      getContentHeight: () => 2953 + zone.height - 152,
      getScrollTop: () => (original ? originalOffset : modifiedOffset),
      setScrollTop: (top: number) => {
        originalOffset = top
        modifiedOffset = top + transform
        fire('scroll')
      },
      getTopForPosition: (line: number) =>
        (line - 1) * 19 + (line >= 2 && line <= 100 ? mappingShift : 0),
      getPositionAtVerticalOffset: (offset: number) =>
        model.validatePosition({
          lineNumber: Math.floor(offset / 19) + 1,
          column: 1
        }),
      getViewZoneAtVerticalOffset: (offset: number) =>
        offset >= zone.top && offset < zone.top + zone.height ? { ...zone } : null,
      getViewZoneBounds: (id: string) => (id === zone.id ? { ...zone } : null),
      getOption: (option: editor.EditorOption) => {
        if (option === monaco.editor.EditorOption.lineHeight) {
          return 19
        }
        if (option === monaco.editor.EditorOption.scrollbar) {
          return { horizontal: 1, horizontalScrollbarSize: 20 }
        }
        if (option === monaco.editor.EditorOption.stickyScroll) {
          return { enabled: false, maxLineCount: 5 }
        }
        if (option === monaco.editor.EditorOption.cursorSurroundingLines) {
          return 0
        }
        if (option === monaco.editor.EditorOption.cursorSurroundingLinesStyle) {
          return 'default'
        }
        throw new Error(`Unexpected option ${option}`)
      },
      changeViewZones: (update: (accessor: editor.IViewZoneChangeAccessor) => void) => {
        const accessor = {
          layoutZone: () => fire('zones'),
          addZone: () => zone.id,
          removeZone: () => {}
        }
        update(accessor)
      },
      onDidContentSizeChange: (listener: () => void) => event('content', listener),
      onDidChangeViewZones: (listener: () => void) => event('zones', listener),
      onDidChangeHiddenAreas: (listener: () => void) => event('hidden', listener),
      onDidChangeConfiguration: (listener: () => void) => event('configuration', listener),
      onDidScrollChange: (listener: () => void) => event('scroll', listener),
      onDidChangeFindWidgetGeometry: (listener: () => void) => event('find', listener),
      onDidRequestSemanticReveal: (
        listener: (request: editor.ISemanticViewRevealRequest) => void
      ) => {
        if (!original) {
          reveal = listener
        }
        return {
          dispose: () => {
            if (!original) {
              reveal = undefined
            }
          }
        }
      },
      setVerticalSelectionDragDelegate: () => ({ dispose: () => {} }),
      setFindWidgetGeometryDelegate: () => ({ dispose: () => {} }),
      stopSelectionDrag: () => lifecycle.push('selection-stop'),
      layoutFindWidget: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the pane methods exercised by native binding and anchor tests.
    return value as unknown as editor.ICodeEditor
  }
  const original = pane(true)
  const modified = pane(false)
  const rawDiff = {
    updateOptions: () => {},
    setModel: () => {},
    restoreViewState: () => {},
    saveViewState: () => null,
    getOriginalEditor: () => original,
    getModifiedEditor: () => modified,
    getScrollTopOffset: () => transform,
    setGeometryDelegate: () => ({ dispose: () => lifecycle.push('delegate-stop') }),
    stopHiddenRegionDrag: () => lifecycle.push('hidden-stop'),
    layout: ({ height }: { height: number }) => {
      nativeHeight = height
      fire('scroll')
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the diff methods exercised by native binding tests.
  const diff = rawDiff as unknown as editor.IStandaloneDiffEditor
  const vm = {
    getDiffState: () => ({
      isDiffUpToDate: true,
      hasResult: true,
      hasChanges: true,
      hasUnchangedRegions: false
    }),
    onDidChangeDiffState: (listener: () => void) => event('diff', listener),
    updateOptions: () => {}
  }
  const record: RetainedDiffItem = {
    model: { original: originalModel, modified: modifiedModel },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Binding tests consume only these readiness and option-update methods.
    viewModel: vm as unknown as editor.IIndependentDiffEditorViewModel,
    viewState: null
  }
  const binding = new CombinedDiffNativeBinding(
    item,
    {
      editor: diff,
      node: document.createElement('div'),
      overflow: document.createElement('div')
    },
    record,
    {},
    body,
    () => lifecycle.push('release')
  )
  const unbind = owner.bind(item, binding)
  await nativeCommit()
  return {
    owner,
    item,
    binding,
    modified,
    zone,
    lifecycle,
    setHorizontal: () => {
      horizontal = true
      fire('content')
    },
    changeHiddenMapping: (shift: number) => {
      mappingShift = shift
      fire('hidden')
    },
    reveal: (source: string, line: number, minimalReveal = false) =>
      reveal?.({
        source,
        model: modifiedModel,
        range: new monaco.Range(line, 1, line, 1),
        selections: null,
        minimalReveal,
        verticalType: 0,
        revealHorizontal: true,
        scrollType: monaco.editor.ScrollType.Immediate
      }),
    dispose: () => {
      unbind()
      unmount()
      owner.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      host.remove()
    }
  }
}
