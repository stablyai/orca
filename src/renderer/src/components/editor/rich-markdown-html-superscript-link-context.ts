import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { resolveMarkdownLinkTarget } from './markdown-internal-links'

export type RichMarkdownHtmlSuperscriptLinkContextSnapshot = {
  version: number
  sourceFilePath: string
  worktreeId: string
  worktreeRoot: string | null
  sourceOwner: HttpLinkSourceOwner
}

export type RichMarkdownHtmlSuperscriptLinkContext = {
  getSnapshot: () => RichMarkdownHtmlSuperscriptLinkContextSnapshot
  subscribe: (listener: () => void) => () => void
  update: (snapshot: Omit<RichMarkdownHtmlSuperscriptLinkContextSnapshot, 'version'>) => void
}

export function createRichMarkdownHtmlSuperscriptLinkContext(
  initial: Omit<RichMarkdownHtmlSuperscriptLinkContextSnapshot, 'version'>
): RichMarkdownHtmlSuperscriptLinkContext {
  let snapshot = { ...initial, version: 0 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (next) => {
      if (
        next.sourceFilePath === snapshot.sourceFilePath &&
        next.worktreeId === snapshot.worktreeId &&
        next.worktreeRoot === snapshot.worktreeRoot &&
        sameOwner(next.sourceOwner, snapshot.sourceOwner)
      ) {
        return
      }
      snapshot = { ...next, version: snapshot.version + 1 }
      listeners.forEach((listener) => listener())
    }
  }
}

export function classifyHtmlSuperscriptLinkAction(
  href: string,
  snapshot: RichMarkdownHtmlSuperscriptLinkContextSnapshot
): boolean {
  if (snapshot.sourceOwner.kind === 'unknown' || /^[\t\n\f\r ]*$/.test(href)) {
    return false
  }
  const target = resolveMarkdownLinkTarget(href, snapshot.sourceFilePath, snapshot.worktreeRoot)
  if (!target) {
    return false
  }
  return !(
    target.kind === 'file' &&
    target.relativePath === undefined &&
    (snapshot.sourceOwner.kind === 'runtime' || snapshot.sourceOwner.kind === 'ssh')
  )
}

function sameOwner(left: HttpLinkSourceOwner, right: HttpLinkSourceOwner): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'runtime' && right.kind === 'runtime') {
    return left.runtimeEnvironmentId === right.runtimeEnvironmentId
  }
  if (left.kind === 'ssh' && right.kind === 'ssh') {
    return left.connectionId === right.connectionId
  }
  return true
}
