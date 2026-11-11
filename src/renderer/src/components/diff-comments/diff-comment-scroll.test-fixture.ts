import { useRef } from 'react'
import { useAppStore } from '@/store'
import { createFakeDiffCommentEditor } from './diff-comment-editor-test-fixture'
import {
  createDiffCommentZoneNavigation,
  usePendingDiffCommentZoneReveal
} from './diff-comment-zone-geometry'
import {
  consumeDiffCommentScrollCommand,
  type DiffCommentScrollCommand
} from './diff-comment-scroll-command'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import type { ZoneEntry } from './diff-comment-view-zone-entry'
import { CombinedDiffViewportOwner } from '../editor/combined-diff/scroll-viewport/combined-diff-viewport-owner'
import { registerCombinedEditorGeometry } from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import { useSourceControlNoteOpening } from '../right-sidebar/source-control/notes/use-note-opening'
import { useDiffCommentDecorator } from './useDiffCommentDecorator'

export const scrollNote: DecoratedDiffComment = {
  id: 'note',
  worktreeId: 'workspace',
  filePath: 'long.ts',
  lineNumber: 40,
  body: 'Review this line',
  createdAt: 1,
  side: 'modified'
}

export async function flushScrollCommand(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

export function createScrollCommandFixture() {
  const owner = new CombinedDiffViewportOwner()
  const host = document.createElement('div')
  Object.defineProperties(host, { clientHeight: { value: 500 }, clientWidth: { value: 800 } })
  document.body.append(host)
  const unmount = owner.mount(host)
  owner.setItems([
    {
      key: 'long.ts',
      generation: '1',
      height: 2000,
      index: 0,
      collapsed: false,
      bodyKind: 'native'
    }
  ])
  const item = owner.getItem('long.ts')!
  let ready = false
  const unbind = owner.bind(item, {
    readHeight: () => (ready ? 2000 : null),
    apply: () => {},
    capture: () => null,
    hasFocus: () => false,
    detach: () => owner.releaseItemNavigation(item)
  })
  const pendingScrollRef: { current: string | null } = { current: null }
  const combinedScrollRequestRef: { current: DiffCommentScrollCommand | null } = { current: null }
  const scrollToZoneFrameRef: { current: number | null } = { current: null }
  const scrollToZoneRef: { current: ((id: string) => void) | null } = { current: null }
  const onPendingScrollConsumedRef = { current: consumeDiffCommentScrollCommand }
  const zonesRef = { current: new Map<string, ZoneEntry>() }
  const cancelScrollToZoneFrame = (): void => {
    if (scrollToZoneFrameRef.current !== null) {
      cancelAnimationFrame(scrollToZoneFrameRef.current)
    }
    scrollToZoneFrameRef.current = null
  }
  const releases: (() => void)[] = []
  const bindEditor = (combined = true) => {
    const fake = createFakeDiffCommentEditor()
    const layouts = new Set<() => void>()
    const layoutInfo = fake.editor.getLayoutInfo()
    let contentWidth = 0
    Object.assign(fake.editor, {
      getViewZoneBounds: () => ({ hidden: false }),
      getScrollWidth: () => 800,
      getLayoutInfo: () => ({ ...layoutInfo, contentWidth }),
      onDidLayoutChange: (listener: () => void) => {
        layouts.add(listener)
        return { dispose: () => layouts.delete(listener) }
      },
      onDidContentSizeChange: () => ({ dispose: () => {} })
    })
    const node = document.createElement('div')
    const card = document.createElement('div')
    node.style.padding = '0px'
    Object.defineProperty(card, 'offsetHeight', { value: 152 })
    card.getBoundingClientRect = () => new DOMRect(0, 0, 400, 152)
    node.append(card)
    host.append(node)
    const identity = String(releases.length)
    const entry: ZoneEntry = {
      zoneId: 'zone',
      domNode: node,
      delegate: { afterLineNumber: 40, heightInPx: 152, domNode: node },
      root: { render: () => {}, unmount: () => {} },
      lifetime: new AbortController(),
      disposeMouseDownStopper: () => {},
      lastRenderSignature: '',
      laidOut: true
    }
    zonesRef.current = new Map([[scrollNote.id, entry]])
    const unregister = registerCombinedEditorGeometry(fake.editor, {
      item,
      identity,
      onUnbind: new Set(),
      registerZone: () => () => {},
      measureZone: (_id, _node, measure) => measure(),
      zonePoint: (_id, zoneNode) => ({
        isValid: () => zoneNode.isConnected && !entry.lifetime.signal.aborted,
        project: () => 800 - owner.getScrollTop(),
        resolveScrollTop: (displacement) => 800 - displacement,
        revealDisplacement: () => 100,
        dispose: () => {}
      })
    })
    const navigation = createDiffCommentZoneNavigation({
      editor: fake.editor,
      monacoModelIdentity: identity,
      zones: zonesRef.current,
      combined,
      pendingScrollRef,
      combinedScrollRequestRef,
      scrollToZoneFrameRef,
      onPendingScrollConsumedRef,
      cancelScrollToZoneFrame
    })
    scrollToZoneRef.current = navigation.scrollToZone
    releases.push(() => {
      unregister()
      fake.domNode.remove()
      node.remove()
    })
    return {
      editor: fake.editor,
      identity,
      navigation,
      fake,
      layout: () => {
        contentWidth = 800
        layouts.forEach((listener) => listener())
      }
    }
  }
  function useOpening() {
    const sourceControlRef = useRef<HTMLDivElement | null>(null)
    return useSourceControlNoteOpening({
      activeWorktreeId: 'workspace',
      worktreePath: '/workspace',
      entries: [{ path: 'long.ts', area: 'unstaged', status: 'modified' }],
      branchEntries: [],
      branchSummary: null,
      handleOpenDiff: () => {},
      openCommittedDiff: () => {},
      sourceControlRef
    })
  }
  function useSurface(surface: ReturnType<typeof bindEditor>) {
    const id = useAppStore((state) => state.scrollToDiffCommentId)
    const opening = useOpening()
    usePendingDiffCommentZoneReveal({
      editor: surface.editor,
      monacoModelIdentity: surface.identity,
      comments: [scrollNote],
      filePath: 'long.ts',
      worktreeId: 'workspace',
      pendingScrollCommentId: id,
      pendingScrollRef,
      combinedScrollRequestRef,
      zonesRef,
      scrollToZoneRef,
      cancelScrollToZoneFrame
    })
    return opening
  }
  const comments = [scrollNote]
  const deleteComment = (): void => {}
  function useDecoratorSurface(
    surface: ReturnType<typeof bindEditor> | null,
    addButtonLabel: string,
    onConsumed: (id: string) => void
  ) {
    const id = useAppStore((state) => state.scrollToDiffCommentId)
    const opening = useOpening()
    useDiffCommentDecorator({
      editor: surface?.editor ?? null,
      monacoModelIdentity: surface?.identity,
      filePath: scrollNote.filePath,
      worktreeId: scrollNote.worktreeId,
      comments,
      addButtonLabel,
      onDeleteComment: deleteComment,
      pendingScrollCommentId: id,
      onPendingScrollConsumed: onConsumed
    })
    return opening
  }
  return {
    owner,
    item,
    bindEditor,
    useSurface,
    useDecoratorSurface,
    combinedScrollRequestRef,
    setReady: (value: boolean) => {
      ready = value
      owner.invalidate(item)
    },
    dispose: () => {
      unbind()
      unmount()
      owner.dispose()
      releases.forEach((release) => release())
      host.remove()
    }
  }
}
