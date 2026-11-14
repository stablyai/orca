import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import {
  isLocalPathOpenBlocked,
  type LocalPathOpenOwner
} from '../files/os-open/local-path-open-guard'
import { getRendererAppPlatform } from '../../app-shell/platform/renderer-app-platform'
import { isWebClientLocation } from '../../app-shell/platform/web-client-location'

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
