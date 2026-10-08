import { normalizeRelativePath } from '@/lib/path'

export function splitPathSegments(path: string, rootPath?: string | null): string[] {
  return normalizeRelativePath(path, rootPath).split('/').filter(Boolean)
}
