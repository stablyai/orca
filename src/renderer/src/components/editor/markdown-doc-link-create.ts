import type { MarkdownDocument } from '../../../../shared/types'
import { basename, joinPath } from '@/lib/path'
import {
  createRuntimePath,
  runtimePathExists,
  writeRuntimeFile,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { getCreatableMarkdownDocLinkTarget, stripMarkdownExtension } from './markdown-doc-links'

type RuntimeFileActions = {
  createPath: typeof createRuntimePath
  pathExists: typeof runtimePathExists
  writeFile: typeof writeRuntimeFile
}

type CreateMissingMarkdownDocLinkDocumentArgs = {
  actions?: RuntimeFileActions
  context: RuntimeFileOperationArgs
  target: string
  worktreePath: string
}

function createMarkdownDocumentRecord(
  worktreePath: string,
  relativePath: string
): MarkdownDocument {
  const fileName = basename(relativePath)
  return {
    filePath: joinPath(worktreePath, relativePath),
    relativePath,
    basename: fileName,
    name: stripMarkdownExtension(fileName)
  }
}

function isRuntimeFileExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('eexist') || message.includes('already exists')
}

export function getInitialMarkdownDocLinkDocumentContent(title: string): string {
  return `# ${title}\n`
}

export async function createMissingMarkdownDocLinkDocument({
  actions = {
    createPath: createRuntimePath,
    pathExists: runtimePathExists,
    writeFile: writeRuntimeFile
  },
  context,
  target,
  worktreePath
}: CreateMissingMarkdownDocLinkDocumentArgs): Promise<MarkdownDocument | null> {
  const creatable = getCreatableMarkdownDocLinkTarget(target)
  if (!creatable) {
    return null
  }

  const document = createMarkdownDocumentRecord(worktreePath, creatable.relativePath)
  if (await actions.pathExists(context, document.filePath)) {
    return document
  }

  try {
    await actions.createPath(context, document.filePath, 'file')
  } catch (err) {
    if (isRuntimeFileExistsError(err)) {
      return document
    }
    throw err
  }
  await actions.writeFile(
    context,
    document.filePath,
    getInitialMarkdownDocLinkDocumentContent(creatable.title)
  )
  return document
}
