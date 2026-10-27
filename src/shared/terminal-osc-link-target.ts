import { isWindowsAbsolutePathLike } from './cross-platform-path'
import {
  resolveTerminalFileUrlTarget,
  type TerminalFileUrlTarget
} from './terminal-file-url-target'
import { findExactTerminalFileLink, type ParsedTerminalFileLink } from './terminal-links'

export type TerminalOscLinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file-url'; target: TerminalFileUrlTarget }
  | { kind: 'path'; link: ParsedTerminalFileLink }

export type TerminalOscLinkTargetOptions = {
  /** URL parsing reads a drive letter as a scheme, so Windows hosts try the path reading first. */
  windowsPathsFirst: boolean
  allowUncHost: boolean
}

/** What an OSC 8 hyperlink's URI points at; callers resolve paths against their own cwd. */
export function classifyTerminalOscLinkTarget(
  rawText: string,
  options: TerminalOscLinkTargetOptions
): TerminalOscLinkTarget | null {
  const pathTarget = (): TerminalOscLinkTarget | null => {
    const link = findExactTerminalFileLink(rawText)
    return link ? { kind: 'path', link } : null
  }
  const windowsPath =
    options.windowsPathsFirst && isWindowsAbsolutePathLike(rawText) ? pathTarget() : null
  if (windowsPath) {
    return windowsPath
  }
  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    return pathTarget()
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { kind: 'url', url: parsed.toString() }
  }
  if (parsed.protocol !== 'file:') {
    return null
  }
  const target = resolveTerminalFileUrlTarget(parsed, { allowUncHost: options.allowUncHost })
  return target ? { kind: 'file-url', target } : null
}
