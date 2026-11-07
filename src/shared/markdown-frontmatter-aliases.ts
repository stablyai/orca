import { open } from 'node:fs/promises'
import type { MarkdownDocument } from './filesystem-entry-types'

const MAX_FRONTMATTER_SCAN_DOCUMENTS = 2_000
const MAX_FRONTMATTER_READ_BYTES = 2_048
const FRONTMATTER_READ_CONCURRENCY = 16

function stripYamlQuotes(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function extractMarkdownFrontmatterAliases(content: string): string[] | undefined {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return undefined
  }
  const endMatch = /\r?\n---(?:\r?\n|$)/.exec(normalized.slice(3))
  if (!endMatch) {
    return undefined
  }
  const frontmatter = normalized.slice(3, 3 + endMatch.index)
  const lines = frontmatter.split(/\r?\n/)
  const aliases: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const keyMatch = /^aliases?:\s*(.*)$/i.exec(line)
    if (!keyMatch) {
      continue
    }
    const inlineValue = (keyMatch[1] ?? '').trim()
    if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
      const inner = inlineValue.slice(1, -1).trim()
      if (inner) {
        for (const item of inner.split(',')) {
          const parsed = stripYamlQuotes(item)
          if (parsed) {
            aliases.push(parsed)
          }
        }
      }
      continue
    }
    if (inlineValue) {
      const parsed = stripYamlQuotes(inlineValue)
      if (parsed) {
        aliases.push(parsed)
      }
      continue
    }
    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1] ?? ''
      const itemMatch = /^\s*-\s+(.+)$/.exec(nextLine)
      if (!itemMatch) {
        break
      }
      const parsed = stripYamlQuotes(itemMatch[1] ?? '')
      if (parsed) {
        aliases.push(parsed)
      }
      i += 1
    }
  }

  return aliases.length > 0 ? aliases : undefined
}

async function readDocumentAliases(filePath: string): Promise<string[] | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.allocUnsafe(MAX_FRONTMATTER_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_FRONTMATTER_READ_BYTES, 0)
    if (bytesRead <= 4) {
      return undefined
    }
    return extractMarkdownFrontmatterAliases(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function populateMarkdownDocumentAliases(
  documents: MarkdownDocument[],
  signal?: AbortSignal
): Promise<MarkdownDocument[]> {
  if (documents.length === 0 || documents.length > MAX_FRONTMATTER_SCAN_DOCUMENTS) {
    return documents
  }
  let index = 0
  const workers = Array.from(
    { length: Math.min(FRONTMATTER_READ_CONCURRENCY, documents.length) },
    async () => {
      while (index < documents.length) {
        if (signal?.aborted) {
          return
        }
        const current = documents[index]
        index += 1
        if (!current) {
          continue
        }
        const aliases = await readDocumentAliases(current.filePath)
        if (aliases && aliases.length > 0) {
          current.aliases = aliases
        }
      }
    }
  )
  await Promise.all(workers)
  return documents
}
