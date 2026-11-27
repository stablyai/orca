import { defineFixture } from '../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatDock } from '../pane/dock/NativeChatDock'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'

// The question from the report, ending in a marker so a clipped tail is unmistakable.
const LONG_QUESTION =
  'tools/ci/check-openapi-breaking-changes.sh:27 — a reviewer (‼️ Must do): the sign-off files api/breaking-changes/{customer-facing,mobile}.md are passed whole to oasdiff --err-ignore, so a line signed off months ago keeps allowing the same break on that endpoint today. Should I narrow the ignore file to the exact rule ids this change needs, or keep the whole-file sign-off and add a comment explaining why? — end of question.'

// The card in a dock, in panes short enough that it runs out of room: a tall question, four
// described options and free input. The dock takes the pane's remaining height, as it does in the
// app, so the fit sees the room the pane really has.
function ConstrainedPane({ width, height }: { width: number; height: number }) {
  return (
    <div
      data-native-chat-root="true"
      className="native-chat-appearance flex flex-col overflow-hidden bg-chat-pane"
      style={{ ...nativeChatAppearanceStyle({}), width, height }}
    >
      <div className="flex min-h-[calc(var(--spacing)*20)] flex-1 flex-col justify-end overflow-hidden p-4 text-sm text-muted-foreground [[data-native-chat-dock-fit~=transcript]_&]:min-h-0">
        Here is the draft for the OpenAPI change.
      </div>
      <NativeChatDock>
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: LONG_QUESTION,
                multiSelect: false,
                options: [
                  {
                    label: 'Narrow the ignore file',
                    description: 'Sign off only the rule ids this needs.'
                  },
                  {
                    label: 'Keep the whole sign-off',
                    description: 'Add a comment on why it stays.'
                  },
                  { label: 'Ask the reviewer first', description: 'Post a thread before editing.' },
                  { label: 'Something else', description: 'Type another approach below.' }
                ]
              }
            ]
          }}
          onAnswer={() => {}}
          onCancel={() => {}}
          // The card takes focus as it opens, so the digits and arrows below reach it.
          shouldFocus
        />
      </NativeChatDock>
    </div>
  )
}

export const constrainedDock = defineFixture({
  width: 380,
  render: () => <ConstrainedPane width={380} height={312} />
})

export const tinyDock = defineFixture({
  width: 220,
  render: () => <ConstrainedPane width={220} height={200} />
})
