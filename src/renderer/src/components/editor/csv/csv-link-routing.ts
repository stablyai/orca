import { getConnectionIdForFile } from '@/lib/connection-context'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { resolveMarkdownPreviewHttpOpenOptions } from '../markdown-preview-links'

export function openCsvHttpLink(
  url: string,
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  file: {
    filePath: string
    worktreeId?: string
    runtimeEnvironmentId?: string | null
    connectionId?: string | null
  }
): void {
  const runtimeId = file.runtimeEnvironmentId?.trim()
  const connectionId = runtimeId
    ? undefined
    : file.connectionId !== undefined
      ? file.connectionId
      : getConnectionIdForFile(file.worktreeId ?? null, file.filePath)
  const sourceOwner: HttpLinkSourceOwner = runtimeId
    ? { kind: 'runtime', runtimeEnvironmentId: runtimeId }
    : connectionId === undefined
      ? { kind: 'unknown' }
      : connectionId === null
        ? { kind: 'local' }
        : { kind: 'ssh', connectionId }
  openHttpLink(
    url,
    resolveMarkdownPreviewHttpOpenOptions(
      event,
      navigator.userAgent.includes('Mac'),
      file.worktreeId ?? null,
      sourceOwner
    )
  )
}
