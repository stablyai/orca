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
