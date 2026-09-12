import { toast } from 'sonner'
import type { Tab } from '../../../../shared/tab-types'
import { translate } from '@/i18n/i18n'
import {
  CANVAS_STORAGE_PREFIX,
  changeCanvasDocument,
  readCanvasDocument
} from './canvas-document-access'
import { removeCanvasNodes } from './agent-canvas-document'
import { canvasNodeUsesTab } from './canvas-resource-tabs'

export function removeClosedTabFromCanvases(closed: Tab, tabs: Tab[]): void {
  if (
    typeof localStorage === 'undefined' ||
    !['terminal', 'browser'].includes(closed.contentType)
  ) {
    return
  }
  for (const canvas of tabs) {
    if (
      canvas.contentType !== 'canvas' ||
      canvas.worktreeId !== closed.worktreeId ||
      canvas.executionHostId !== closed.executionHostId
    ) {
      continue
    }
    const scope = JSON.stringify([
      'workspace-tab',
      canvas.executionHostId,
      canvas.worktreeId,
      canvas.id
    ])
    try {
      const saved = readCanvasDocument(CANVAS_STORAGE_PREFIX + scope)
      if (saved.error) {
        throw new Error(saved.error)
      }
      const ids = new Set(
        saved.document.nodes
          .filter((node) => canvasNodeUsesTab(node, closed))
          .map((node) => node.id)
      )
      changeCanvasDocument(scope, (document) => removeCanvasNodes(document, ids), closed)
    } catch {
      toast.error(
        translate(
          'agentCanvas.closeSyncFailed',
          'The tab closed, but its canvas card could not be removed. Remove the card manually.'
        )
      )
    }
  }
}
