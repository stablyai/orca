import { describe, expect, it } from 'vitest'
import { buildAutomationRunPreamble, splitAutomationRunMessage } from './automation-run-preamble'
import { nativeChatMessageCopyText } from './native-chat-message-copy-text'

describe('splitAutomationRunMessage', () => {
  it.each(['orca', 'orca-dev', 'orca-ide', '/opt/bin/custom-orca', '"/opt/Orca Dev/orca"'])(
    'recognizes the exact %s preamble',
    (cli) => {
      const task = '  Keep task whitespace\n=== TASK ===\n'
      const preamble = buildAutomationRunPreamble(cli)
      expect(splitAutomationRunMessage(preamble + task)).toEqual({
        instructions: preamble.slice(0, -'=== TASK ===\n'.length).trimEnd(),
        task
      })
      expect(
        nativeChatMessageCopyText({
          role: 'user',
          blocks: [{ type: 'text', text: preamble + task }]
        })
      ).toBe(task)
    }
  )

  it('leaves plain messages and near misses intact', () => {
    const preamble = buildAutomationRunPreamble('orca')
    for (const text of [
      'Do the task\n=== TASK ===\n',
      `prefix\n${preamble}task`,
      `${preamble.replace('current run', 'another run')}task`,
      `${preamble.replace('orca automations fail', 'orca-dev automations fail')}task`,
      `${preamble.replace('=== TASK ===\n', '=== TASK ===')}task`,
      `${preamble.replaceAll('\n', '\r\n')}task`
    ]) {
      expect(splitAutomationRunMessage(text)).toBeNull()
    }
  })
})
