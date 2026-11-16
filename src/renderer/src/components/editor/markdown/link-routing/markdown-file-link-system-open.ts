import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { fileUrlToAbsolutePath } from './markdown-preview-links'

/**
 * Hand a local Markdown file link to the OS default app. Main never launches scripts from a link:
 * it answers `open-in-editor` for readable ones, which open in an Orca editor tab, or are revealed
 * in the file manager when the link has no workspace to open the tab in.
 */
export async function openMarkdownFileLinkWithSystemDefault(
  fileUri: string,
  openInEditor: (() => void) | null
): Promise<void> {
  const result = await window.api.shell.openFileUri(fileUri, LOCAL_EXECUTION_HOST_ID)
  if (result !== 'open-in-editor') {
    return
  }
  if (openInEditor) {
    openInEditor()
    return
  }
  let absolutePath: string | null = null
  try {
    absolutePath = fileUrlToAbsolutePath(new URL(fileUri))
  } catch {
    return
  }
  if (absolutePath) {
    await window.api.shell.openInFileManager(absolutePath, LOCAL_EXECUTION_HOST_ID)
  }
}
