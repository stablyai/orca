import { Component, type ReactNode } from 'react'
import type { NativeChatContentSnapshot } from './use-native-chat-content-anchor'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'

/** The published history the rows draw: an admitted older prefix bumps the revision. */
export type NativeChatPrependAnchor = {
  sourceKey: string
  prependRevision: number
  isVisible: boolean
}

type Props = {
  anchor: NativeChatPrependAnchor
  window: NativeChatTranscriptWindow
  children: ReactNode
}

type Snapshot = { content: NativeChatContentSnapshot; hidden: boolean }

/** A layout-effect cleanup can run after mutation; this boundary reads the old content boxes. */
export class NativeChatPrependSnapshot extends Component<Props> {
  // A prepend while hidden restores against the content the reader last saw.
  private hidden: { content: NativeChatContentSnapshot; revision: number } | null = null

  getSnapshotBeforeUpdate(previousProps: Props): Snapshot | null {
    const previous = previousProps.anchor
    const next = this.props.anchor
    if (previous.sourceKey !== next.sourceKey) {
      return null
    }
    if (
      previous.isVisible &&
      (!next.isVisible || previous.prependRevision !== next.prependRevision)
    ) {
      const content = previousProps.window.snapshotContent()
      return content ? { content, hidden: !next.isVisible } : null
    }
    if (
      !previous.isVisible &&
      next.isVisible &&
      this.hidden &&
      this.hidden.revision !== next.prependRevision
    ) {
      return { content: this.hidden.content, hidden: false }
    }
    return null
  }

  componentDidUpdate(previousProps: Props, _state: unknown, snapshot: Snapshot | null) {
    const previous = previousProps.anchor
    if (previous.sourceKey !== this.props.anchor.sourceKey) {
      this.hidden = null
    } else if (snapshot?.hidden) {
      this.hidden = { content: snapshot.content, revision: previous.prependRevision }
    } else if (snapshot) {
      this.props.window.preserveContent(snapshot.content)
    }
    if (this.props.anchor.isVisible) {
      this.hidden = null
    }
  }

  render(): ReactNode {
    return this.props.children
  }
}
