import { relativePathInsideRoot } from '../../file-access/cross-platform-path'

/** Where relative paths in a chat resolve when its host runs it in a workspace sub-folder (a
 *  conversation adopted from one); null for the workspace itself or a folder outside it as written.
 *  File operations stay addressed from the workspace, which paired hosts resolve paths under. */
export function nativeChatPathBase(
  workspacePath: string,
  launchDirectory: string | null | undefined
): string | null {
  return launchDirectory && relativePathInsideRoot(workspacePath, launchDirectory)
    ? launchDirectory
    : null
}
