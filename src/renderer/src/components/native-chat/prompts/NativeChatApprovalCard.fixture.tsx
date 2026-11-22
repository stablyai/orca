import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'

export const fileChanges = defineFixture({
  width: 720,
  render: () => (
    <NativeChatApprovalCard
      approval={{
        title: 'Apply file changes?',
        description: 'Write access: /workspace',
        decisionReason: 'These changes write outside the sandbox.',
        detail:
          'update /workspace/src/greeting.ts\nadd /workspace/greeting.test.ts\n\n/workspace/src/greeting.ts\n@@ -1 +1 @@\n-export const greeting = "Hi"\n+export const greeting = "Hello"\n\n/workspace/greeting.test.ts\nexpect(greeting).toBe("Hello")\n',
        options: [
          { label: 'Allow', send: 'accept' },
          { label: 'Allow for this session', send: 'acceptForSession' },
          { label: 'Deny', send: 'decline' },
          { label: 'Stop', send: 'cancel' }
        ]
      }}
      onChoose={() => {}}
    />
  )
})

const expandDetails = (frame: HTMLElement): void => {
  frame
    .querySelector<HTMLButtonElement>('[data-native-chat-approval-actions] [aria-expanded]')
    ?.click()
}

export const fileChangesExpanded = defineFixture({ ...fileChanges, interact: expandDetails })

export const narrowFileChanges = defineFixture({
  width: 360,
  render: () => (
    <NativeChatApprovalCard
      approval={{
        title: 'Apply file changes?',
        description: 'Write access: /workspace/long-project-name/src',
        decisionReason: 'These changes write outside the sandbox.',
        detail: `update /workspace/long-project-name/src/greeting.ts\nadd /workspace/long-project-name/greeting.test.ts\n\n${'argument-context '.repeat(40)}\n@@ -1 +1 @@\n-old\n+new\n${'+long proposal line\n'.repeat(30)}`,
        options: [
          { label: 'Allow', send: 'accept' },
          { label: 'Allow for this session', send: 'acceptForSession' },
          { label: 'Deny', send: 'decline' },
          { label: 'Stop', send: 'cancel' }
        ]
      }}
      onChoose={() => {}}
    />
  )
})

export const narrowFileChangesExpanded = defineFixture({
  ...narrowFileChanges,
  interact: expandDetails
})

const LONG_OPTIONS = [
  { label: 'Yes', send: '1' },
  { label: "Yes, and don't ask again for git commands in /workspace/orca", send: '2' },
  { label: 'Yes, allow all edits during this session', send: '3' },
  { label: 'No, and tell Claude what to do differently', send: '4' },
  { label: 'Allow for this project only', send: '5' },
  { label: 'Stop', send: '6' }
]

function choices(count: number, width: number) {
  return defineFixture({
    width,
    render: () => (
      <div className="native-chat-appearance bg-chat-canvas" style={nativeChatAppearanceStyle({})}>
        <NativeChatApprovalCard
          approval={{
            title: 'Run git commit -m "Update the greeting"?',
            detail: 'git commit -m "Update the greeting"',
            options: LONG_OPTIONS.slice(0, count)
          }}
          onChoose={() => {}}
          onCancel={() => {}}
        />
      </div>
    )
  })
}

export const twoChoices = choices(2, 720)
export const fourChoices = choices(4, 720)
export const sixChoices = choices(6, 720)
export const narrowTwoChoices = choices(2, 360)
export const narrowFourChoices = choices(4, 360)
export const narrowSixChoices = choices(6, 360)

// A short split pane: the answers that do not fit stay reachable by scrolling the card.
export const shortPane = defineFixture({
  width: 288,
  render: () => (
    <div
      className="native-chat-appearance flex h-[135px] flex-col bg-chat-canvas"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatApprovalCard
        approval={{
          title: 'Run git commit -m "Update the greeting"?',
          detail: 'git commit -m "Update the greeting"',
          options: LONG_OPTIONS.slice(0, 4)
        }}
        onChoose={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
})

export const shortPaneScrolled = defineFixture({
  ...shortPane,
  interact: (frame) => {
    const card = frame.querySelector<HTMLElement>('[data-native-chat-approval-card]')
    card?.scrollTo({ top: card.scrollHeight })
  }
})
