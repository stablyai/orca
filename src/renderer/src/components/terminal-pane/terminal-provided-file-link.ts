import type { ILink } from '@xterm/xterm'
import type { WrappedLogicalLine } from './wrapped-terminal-link-ranges'

// Why: a candidate link paired with the logical line it came from. Lives in its
// own module so the link provider and the overlap selector can share the type
// without an import cycle between handlers and overlap-selection.
export type ProvidedFileLink = {
  link: ILink
  logicalLine: WrappedLogicalLine
}
