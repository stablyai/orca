import type { DirEntry, GlobalSettings } from '../../../shared/types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  readRuntimeDirectory,
  readRuntimeFileContent,
  runtimePathExists
} from '@/runtime/runtime-file-client'
import { basename, joinPath, normalizeRelativePath } from './path'

const MARKDOWN_TEMPLATE_ROOT = '.orca/templates'
const MARKDOWN_TEMPLATE_MAX_DEPTH = 8
const MARKDOWN_TEMPLATE_MAX_COUNT = 100

export type MarkdownDocumentTemplate = {
  id: string
  name: string
  filePath: string
  relativePath: string
  templateRelativePath: string
  basename: string
}

export type MarkdownTemplatePlaceholderValues = {
  title: string
  filename: string
  now?: Date
}

function isMarkdownTemplateName(name: string): boolean {
  const lowerName = name.toLowerCase()
  return lowerName.endsWith('.md') || lowerName.endsWith('.mdx') || lowerName.endsWith('.markdown')
}

function stripMarkdownExtension(name: string): string {
  return name.replace(/\.(markdown|mdx|md)$/i, '')
}

function titleFromName(name: string): string {
  const stem = foldMarkdownTemplateTitleWhitespace(
    stripMarkdownExtension(name).replace(/[-_]+/g, ' ')
  )

  if (!stem) {
    return 'Untitled'
  }

  return stem.charAt(0).toUpperCase() + stem.slice(1)
}

// Why: template names can originate from pasted/remote filenames; title display
// only needs collapsed whitespace, not a whole-string whitespace regex pass.
function foldMarkdownTemplateTitleWhitespace(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isMarkdownTemplateTitleWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index)
  }
  return normalized
}

function isMarkdownTemplateTitleWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate(now: Date): string {
  return `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())}`
}

function formatTime(now: Date): string {
  return `${padDatePart(now.getHours())}:${padDatePart(now.getMinutes())}`
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /ENOENT|not found|no such file/i.test(error.message)
}

function shouldSkipTemplateDirectory(entry: DirEntry): boolean {
  return entry.isSymlink || entry.name === '.git' || entry.name === 'node_modules'
}

export function getMarkdownTemplateTitleForFileName(fileName: string): string {
  return titleFromName(fileName)
}

export function applyMarkdownTemplatePlaceholders(
  content: string,
  values: MarkdownTemplatePlaceholderValues
): string {
  const now = values.now ?? new Date()
  const date = formatDate(now)
  const time = formatTime(now)
  const replacements: Record<string, string> = {
    title: values.title,
    filename: values.filename,
    date,
    time,
    datetime: `${date} ${time}`
  }

  return content.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match
  })
}

export async function listMarkdownDocumentTemplates(
  context: RuntimeFileOperationArgs,
  worktreePath: string
): Promise<MarkdownDocumentTemplate[]> {
  const templates: MarkdownDocumentTemplate[] = []
  const rootPath = joinPath(worktreePath, MARKDOWN_TEMPLATE_ROOT)

  // Why: missing template directories are the normal case. Probe quietly first
  // so Electron does not log an IPC handler error for an optional feature.
  if (!(await runtimePathExists(context, rootPath))) {
    return []
  }

  async function visitDirectory(
    dirPath: string,
    relativeDir: string,
    depth: number
  ): Promise<void> {
    if (depth > MARKDOWN_TEMPLATE_MAX_DEPTH || templates.length >= MARKDOWN_TEMPLATE_MAX_COUNT) {
      return
    }

    let entries: DirEntry[]
    try {
      entries = await readRuntimeDirectory(context, dirPath)
    } catch (error) {
      if (relativeDir === '' && isMissingPathError(error)) {
        return
      }
      throw error
    }

    for (const entry of entries) {
      if (templates.length >= MARKDOWN_TEMPLATE_MAX_COUNT) {
        return
      }

      const entryRelativePath = normalizeRelativePath(
        relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      )
      const entryPath = joinPath(rootPath, entryRelativePath)

      if (entry.isDirectory) {
        if (!shouldSkipTemplateDirectory(entry)) {
          await visitDirectory(entryPath, entryRelativePath, depth + 1)
        }
        continue
      }

      if (entry.isSymlink || !isMarkdownTemplateName(entry.name)) {
        continue
      }

      const templateRelativePath = entryRelativePath
      const rootRelativePath = normalizeRelativePath(
        `${MARKDOWN_TEMPLATE_ROOT}/${templateRelativePath}`
      )
      templates.push({
        id: rootRelativePath,
        name: titleFromName(entry.name),
        filePath: joinPath(worktreePath, rootRelativePath),
        relativePath: rootRelativePath,
        templateRelativePath,
        basename: basename(entry.name)
      })
    }
  }

  await visitDirectory(rootPath, '', 0)

  return templates.sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name)
    return nameCompare === 0
      ? a.templateRelativePath.localeCompare(b.templateRelativePath)
      : nameCompare
  })
}

export async function readMarkdownDocumentTemplateContent(
  context: {
    settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
    worktreeId: string
    connectionId?: string
  },
  template: MarkdownDocumentTemplate
): Promise<string> {
  const result = await readRuntimeFileContent({
    settings: context.settings,
    filePath: template.filePath,
    relativePath: template.relativePath,
    worktreeId: context.worktreeId,
    connectionId: context.connectionId
  })

  if (result.isBinary) {
    throw new Error(`Markdown template "${template.templateRelativePath}" is not a text file.`)
  }

  return result.content
}
