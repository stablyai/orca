import type { ArtifactWriteRequest } from '../../../../../shared/artifacts'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../../../../shared/artifacts'
import { getRuntimePathBasename } from '../../../../../shared/cross-platform-path'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'

export type ShareableBrowserArtifactFile = {
  fileName: string
  filePath: string
}

export function browserFileUrlToAbsolutePath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') {
      return null
    }
    const hostPrefix =
      parsed.hostname && parsed.hostname !== 'localhost' ? `//${parsed.hostname}` : ''
    let absolutePath = `${hostPrefix}${decodeURIComponent(parsed.pathname)}`
    if (/^\/[A-Za-z]:\//.test(absolutePath)) {
      absolutePath = absolutePath.slice(1)
    }
    if (/^[A-Za-z]:\//.test(absolutePath) || absolutePath.startsWith('//')) {
      absolutePath = absolutePath.replaceAll('/', '\\')
    }
    return absolutePath
  } catch {
    return null
  }
}

export function getShareableBrowserArtifactFile(url: string): ShareableBrowserArtifactFile | null {
  const filePath = browserFileUrlToAbsolutePath(url)
  if (!filePath || !/\.html?$/i.test(filePath)) {
    return null
  }
  const fileName = getRuntimePathBasename(filePath)
  return fileName ? { fileName, filePath } : null
}

export async function readBrowserHtmlArtifactRequest(url: string): Promise<ArtifactWriteRequest> {
  const file = getShareableBrowserArtifactFile(url)
  if (!file) {
    throw new ArtifactPublishPreparationError('unsupported')
  }
  try {
    const stat = await window.api.fs.stat({ filePath: file.filePath })
    if (stat.isDirectory) {
      throw new ArtifactPublishPreparationError('unsupported')
    }
    if (stat.size > ARTIFACT_CLI_MAX_RPC_BYTES) {
      throw new ArtifactPublishPreparationError('too-large')
    }
    const result = await window.api.fs.readFile({ filePath: file.filePath })
    if (result.isBinary) {
      throw new ArtifactPublishPreparationError('binary')
    }
    return {
      sourceKey: file.filePath,
      content: result.content,
      contentType: 'text/html',
      fileName: file.fileName
    }
  } catch (error) {
    if (error instanceof ArtifactPublishPreparationError) {
      throw error
    }
    throw new ArtifactPublishPreparationError('unreadable')
  }
}
