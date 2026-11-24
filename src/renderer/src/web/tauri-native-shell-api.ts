import type { PreloadApi } from '../../../preload/api-types'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathFailureReason,
  ShellOpenLocalPathResult
} from '../../../shared/shell/opening/shell-open-types'
import {
  parseRoutableExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { getWindowsPathAccess } from '@/lib/files/os-open/windows-path-access'
import { validatePathExistenceBatch } from '../../../shared/file-access/path-existence-batch'
import type { SshExternalEditorAuthorityResult } from '../../../shared/remote-runtime/ssh/ssh-types'
import { createShellApi } from './preload-api/browser/web-shell-api'
import { callRuntimeResult } from './runtime/client/web-runtime-calls'
import { getBrowserPlatform } from './preload-api/web-storage'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'
import { translate } from '@/i18n/i18n'

// Why silent: Electron drops malformed or disallowed URLs without throwing and
// callers fire-and-forget, so a throw would surface as an unhandled rejection.
function isAllowedExternalUrl(url: string): boolean {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return false
  }
  return ['http:', 'https:', 'mailto:', 'tel:'].includes(protocol)
}

function toPickedPaths(value: string | string[] | null): string[] {
  if (Array.isArray(value)) {
    return value
  }
  return value ? [value] : []
}

async function pickPaths(options: Record<string, unknown>): Promise<string[]> {
  const result = await invokePlugin<string | string[] | null>('dialog', 'open', { options })
  return toPickedPaths(result)
}

type ResolvedOwnedShellPath =
  | { ok: true; path: string }
  | { ok: false; reason: ShellOpenLocalPathFailureReason }

/** Drive, UNC and long-path spellings the local Windows shell accepts. */
function isWindowsAbsoluteShellPath(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\')
}

/**
 * Lexical dot-segment cleanup for absolute Windows shell paths, mirroring
 * node's win32.normalize for the spellings above. Symlinks still resolve at
 * open time, exactly like Electron's check-then-open race.
 */
function normalizeWindowsShellPath(path: string): string {
  const unified = path.replace(/\//g, '\\')
  const unc = unified.startsWith('\\\\')
  if (!unc && !/^[A-Za-z]:\\/.test(unified)) {
    return unified
  }
  const prefix = unc ? '\\\\' : unified.slice(0, 3)
  const rest = unc ? unified.slice(2) : unified.slice(3)
  const segments: string[] = []
  for (const segment of rest.split('\\')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `${prefix}${segments.join('\\')}`
}

/** Lexical dot-segment cleanup for absolute POSIX shell paths. */
function normalizePosixShellPath(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/**
 * The desktop side of resolveOwnedPathTarget: this computer's paths resolve
 * as themselves, a WSL host's through its \\wsl.localhost spelling, and
 * every other owner is refused with the same reason main returns.
 */
async function resolveOwnedShellTarget(
  path: string,
  ownerHostId: unknown,
  pathExists: (path: string) => Promise<boolean>
): Promise<ResolvedOwnedShellPath> {
  const host = typeof ownerHostId === 'string' ? parseRoutableExecutionHostId(ownerHostId) : null
  if (host?.kind === 'local') {
    if (getBrowserPlatform() !== 'win32') {
      const normalized = normalizePosixShellPath(path)
      if (!normalized.startsWith('/')) {
        return { ok: false, reason: 'not-absolute' }
      }
      return (await pathExists(normalized))
        ? { ok: true, path: normalized }
        : { ok: false, reason: 'not-found' }
    }
    const normalized = normalizeWindowsShellPath(path)
    if (!isWindowsAbsoluteShellPath(normalized)) {
      return { ok: false, reason: 'not-absolute' }
    }
    return (await pathExists(normalized))
      ? { ok: true, path: normalized }
      : { ok: false, reason: 'not-found' }
  }
  const access = typeof ownerHostId === 'string' ? getWindowsPathAccess(ownerHostId) : null
  if (!access) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
  const windowsPath = access.toWindows(path)
  if (!windowsPath) {
    return { ok: false, reason: 'not-absolute' }
  }
  const normalized = normalizeWindowsShellPath(windowsPath)
  if (!isWindowsAbsoluteShellPath(normalized)) {
    return { ok: false, reason: 'not-absolute' }
  }
  return (await pathExists(normalized))
    ? { ok: true, path: normalized }
    : { ok: false, reason: 'not-found' }
}

export function createTauriNativeShellApi(): NonNullable<Partial<PreloadApi>['shell']> | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }
  const fallback = createShellApi()
  const existsNative = (path: string): Promise<boolean> =>
    invokeNative<boolean>('poc_path_exists', { path })
  const revealNativePath = async (path: string): Promise<ShellOpenLocalPathResult> => {
    try {
      await invokePlugin('opener', 'reveal_item_in_dir', { path })
      return { ok: true }
    } catch {
      return { ok: false, reason: 'launch-failed' }
    }
  }
  const openNativePath = async (path: string): Promise<boolean> => {
    try {
      await invokePlugin('opener', 'open_path', { path, with: null })
      return true
    } catch {
      return false
    }
  }
  const resolveShellTarget = (
    path: string,
    ownerHostId: unknown
  ): Promise<ResolvedOwnedShellPath> => resolveOwnedShellTarget(path, ownerHostId, existsNative)
  return {
    ...fallback,
    // Why reveal, not open: Electron's shell:openPath handler reuses the
    // file-manager reveal path for this legacy fire-and-forget call.
    openPath: async (path, ownerHostId) => {
      const target = await resolveShellTarget(path, ownerHostId)
      if (target.ok) {
        await revealNativePath(target.path)
      }
    },
    openInFileManager: async (path, ownerHostId) => {
      const target = await resolveShellTarget(path, ownerHostId)
      if (!target.ok) {
        return target
      }
      return revealNativePath(target.path)
    },
    openInExternalEditor: async (
      request: ShellOpenExternalEditorRequest
    ): Promise<ShellOpenExternalEditorResult> => {
      try {
        const connectionId = request.connectionId?.trim()
        if (connectionId) {
          if (request.ownerHostId !== toSshExecutionHostId(connectionId)) {
            return { ok: false, reason: 'remote-runtime-unsupported' }
          }
          const authority = await callRuntimeResult<SshExternalEditorAuthorityResult>(
            'ssh.resolveExternalEditorAuthority',
            { targetId: connectionId }
          )
          if (!authority.ok) {
            return authority
          }
          return await invokeNative<ShellOpenExternalEditorResult>('poc_open_external_editor', {
            args: { ...request, sshAuthority: authority.authority }
          })
        }
        return await invokeNative<ShellOpenExternalEditorResult>('poc_open_external_editor', {
          args: request
        })
      } catch {
        return { ok: false, reason: 'launch-failed' }
      }
    },
    openUrl: async (url) => {
      if (!isAllowedExternalUrl(url)) {
        return
      }
      await invokePlugin('opener', 'open_url', { url, with: null })
    },
    openFilePath: async (path, ownerHostId) => {
      const target = await resolveShellTarget(path, ownerHostId)
      if (!target.ok) {
        return false
      }
      return openNativePath(target.path)
    },
    openFileUri: async (uri, ownerHostId) => {
      if (parseRoutableExecutionHostId(ownerHostId)?.kind !== 'local') {
        return 'failed'
      }
      let parsed: URL
      try {
        parsed = new URL(uri)
      } catch {
        return 'failed'
      }
      if (parsed.protocol !== 'file:') {
        return 'failed'
      }
      // Why: only this computer's files open here; a remote host's URI never resolves locally.
      if (parsed.hostname && parsed.hostname !== 'localhost') {
        return 'failed'
      }
      let path = decodeURIComponent(parsed.pathname)
      if (getBrowserPlatform() === 'win32' && /^\/[A-Za-z]:/.test(path)) {
        path = path.slice(1)
      }
      const target = await resolveShellTarget(path, ownerHostId)
      if (!target.ok) {
        return 'failed'
      }
      return (await openNativePath(target.path)) ? 'opened' : 'failed'
    },
    pathsExist: async (paths) => {
      validatePathExistenceBatch(paths)
      return invokeNative<boolean[]>('poc_paths_exist', { paths })
    },
    pathExists: (path) => invokeNative<boolean>('poc_path_exists', { path }),
    pickAttachment: async () =>
      (
        await pickPaths({
          title: translate('auto.web.tauriNative.dialog.selectAttachment', 'Select attachment'),
          multiple: false,
          directory: false
        })
      )[0] ?? null,
    pickAttachments: () =>
      pickPaths({
        title: translate('auto.web.tauriNative.dialog.selectAttachments', 'Select attachments'),
        multiple: true,
        directory: false
      }),
    pickImage: async () =>
      (
        await pickPaths({
          title: translate('auto.web.tauriNative.dialog.selectImage', 'Select image'),
          multiple: false,
          directory: false,
          filters: [
            {
              name: 'Images',
              extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
            }
          ]
        })
      )[0] ?? null,
    pickRepoIconImage: async () => {
      const filePath = (
        await pickPaths({
          title: translate(
            'auto.web.tauriNative.dialog.selectRepositoryIcon',
            'Select repository icon'
          ),
          multiple: false,
          directory: false,
          filters: [{ name: 'PNG images', extensions: ['png'] }]
        })
      )[0]
      return filePath
        ? invokeNative<{ dataUrl: string; fileName: string }>('poc_read_file_data_url', {
            path: filePath
          })
        : null
    },
    pickAudio: async () =>
      (
        await pickPaths({
          title: translate('auto.web.tauriNative.dialog.selectAudio', 'Select audio'),
          multiple: false,
          directory: false,
          filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
        })
      )[0] ?? null,
    pickDirectory: async ({ defaultPath }) =>
      (
        await pickPaths({
          title: translate('auto.web.tauriNative.dialog.selectDirectory', 'Select directory'),
          multiple: false,
          directory: true,
          ...(defaultPath ? { defaultPath } : {})
        })
      )[0] ?? null
  }
}
