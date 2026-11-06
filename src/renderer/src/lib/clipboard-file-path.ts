import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isLocalPathOpenBlocked, type LocalPathOpenOwner } from './local-path-open-guard'
import { getRendererAppPlatform } from './renderer-app-platform'
import { isWebClientLocation } from './web-client-location'

export function formatClipboardFilePath(filePath: string, owner: LocalPathOpenOwner): string {
  if (
    getRendererAppPlatform() !== 'win32' ||
    isWebClientLocation() ||
    isLocalPathOpenBlocked(owner) ||
    !isWindowsAbsolutePathLike(filePath)
  ) {
    return filePath
  }
  return filePath.replace(/\//g, '\\')
}
