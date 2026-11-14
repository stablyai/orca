import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatForkedFromContext } from '../actions/native-chat-fork-context'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'

const open = (): void => {}

function divider(
  sourceName: string,
  flags: { sourceForked?: true; sourceMissing?: true } = {}
): NativeChatTextBlock {
  return {
    type: 'text',
    text: `Forked from ${sourceName}`,
    presentation: 'forked-from',
    forkedFrom: { sessionId: 'source', ...flags }
  }
}

function Row({
  label,
  block,
  canOpen = true
}: {
  label: string
  block: NativeChatTextBlock
  canOpen?: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <NativeChatForkedFromContext.Provider value={canOpen ? open : undefined}>
        <NativeChatNoticeRow block={block} />
      </NativeChatForkedFromContext.Provider>
    </div>
  )
}

function Surface({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="native-chat-appearance space-y-4 bg-background p-4 text-chat-foreground">
      {children}
    </div>
  )
}

export const states = defineFixture({
  width: 640,
  render: () => (
    <Surface>
      <Row label="Source available" block={divider('Annotate capabilities')} />
      <Row
        label="Fork of a fork"
        block={divider('Annotate capabilities', { sourceForked: true })}
      />
      <Row
        label="Source unknown to its host"
        block={divider('another chat', { sourceMissing: true })}
      />
      <Row label="Host disconnected" block={divider('Annotate capabilities')} canOpen={false} />
      <Row
        label="Long source name"
        block={divider(
          'Investigate why the remote worktree sync stalls after reconnecting overnight'
        )}
      />
    </Surface>
  )
})

export const focused = defineFixture({
  width: 640,
  render: () => (
    <Surface>
      <Row label="Keyboard focus" block={divider('Annotate capabilities')} />
    </Surface>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.focus()
  }
})
