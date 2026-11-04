import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'

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
  frame.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
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
