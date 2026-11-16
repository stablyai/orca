import { Copy, ExternalLink } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { LocalOnlyMenuHint } from '@/components/local-only-menu-hint'
import { useAppStore } from '@/store/index'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { isRevealOrEditorOpenBlocked } from '@/lib/files/os-open/local-path-open-guard'
import {
  getRevealInFileManagerLabel,
  getOpenFileRevealOwner,
  revealInFileManager
} from '@/lib/files/os-open/reveal-in-file-manager'
import { useTranslate } from '@/i18n/use-translate'

export function EditorFileLocationMenuItems({
  file,
  onCopyPath
}: {
  file: OpenFile
  onCopyPath: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const revealOwner = useAppStore((state) => getOpenFileRevealOwner(state, file))
  const revealBlocked = isRevealOrEditorOpenBlocked(revealOwner)

  return (
    <>
      <DropdownMenuItem
        disabled={revealBlocked}
        onSelect={() => void revealInFileManager(file.filePath, revealOwner)}
      >
        <ExternalLink />
        {getRevealInFileManagerLabel(t)}
        {revealBlocked ? <LocalOnlyMenuHint /> : null}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onCopyPath}>
        <Copy />
        {t('auto.components.editor.EditorPanelHeader.7c08a1f990', 'Copy Path')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void window.api.ui.writeClipboardText(file.relativePath)}>
        <Copy />
        {t('auto.components.editor.EditorPanelHeader.269ce4842b', 'Copy Relative Path')}
      </DropdownMenuItem>
    </>
  )
}
