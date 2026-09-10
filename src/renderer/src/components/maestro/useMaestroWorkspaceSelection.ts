import { useCallback, useState } from 'react'
import type { WorkspaceCanvasManualLink } from '../../../../shared/maestro-document-contract'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import { maestroWorkspaceMutationKey } from './maestro-workspace-mutation-key'

type MaestroWorkspaceSelection =
  | { kind: 'surface'; surfaceKey: string }
  | { kind: 'manual-link'; linkId: string }
  | null

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.getAttribute('role') === 'textbox')
  )
}

export function clearMaestroWorkspaceCanvasFocus(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
}

export function useMaestroWorkspaceSelection({
  surfaceKeys,
  manualLinks,
  mutate
}: {
  surfaceKeys: readonly string[]
  manualLinks: readonly WorkspaceCanvasManualLink[]
  mutate: MaestroWorkspaceCanvasResource['mutate']
}): {
  selectedSurfaceKey: string | null
  selectedManualLinkId: string | null
  selectSurface: (surfaceKey: string | null) => void
  selectManualLink: (linkId: string) => void
  clearSelection: () => void
  deleteManualLink: (linkId: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
} {
  const [selection, setSelection] = useState<MaestroWorkspaceSelection>(null)
  const selectedSurfaceKey =
    selection?.kind === 'surface' && surfaceKeys.includes(selection.surfaceKey)
      ? selection.surfaceKey
      : null
  const selectedManualLinkId =
    selection?.kind === 'manual-link' && manualLinks.some((link) => link.id === selection.linkId)
      ? selection.linkId
      : null

  const deleteManualLink = useCallback(
    (linkId: string): void => {
      setSelection((selected) =>
        selected?.kind === 'manual-link' && selected.linkId === linkId ? null : selected
      )
      void mutate({
        action: 'delete-manual-link',
        link_id: linkId,
        idempotency_key: maestroWorkspaceMutationKey('delete-link', linkId)
      })
    },
    [mutate]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      if (
        selectedManualLinkId &&
        (event.key === 'Delete' || event.key === 'Backspace') &&
        !isEditableKeyboardTarget(event.target)
      ) {
        event.preventDefault()
        deleteManualLink(selectedManualLinkId)
      }
    },
    [deleteManualLink, selectedManualLinkId]
  )

  return {
    selectedSurfaceKey,
    selectedManualLinkId,
    selectSurface: (surfaceKey) =>
      setSelection(surfaceKey ? { kind: 'surface', surfaceKey } : null),
    selectManualLink: (linkId) => setSelection({ kind: 'manual-link', linkId }),
    clearSelection: () => setSelection(null),
    deleteManualLink,
    onKeyDown
  }
}
