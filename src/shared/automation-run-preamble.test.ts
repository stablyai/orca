import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  automationRunPreambleVersions,
  buildAutomationRunPreamble,
  splitAutomationRunMessage
} from './automation-run-preamble'
import goldenHashes from './automation-run-preamble.versions.golden.json'
import { nativeChatMessageCopyText } from './native-chat-message-copy-text'

it('preserves every shipped preamble version', () => {
  expect(
    automationRunPreambleVersions.map((version) =>
      createHash('sha256').update(version('orca')).digest('hex')
    ),
    'Shipped automation preambles are immutable; add a new version instead.'
  ).toEqual(goldenHashes)
})

describe.each(automationRunPreambleVersions.map((version, index) => ({ version, index })))(
  'splitAutomationRunMessage version $index',
  ({ version }) => {
    it.each([
      'orca',
      'orca-dev',
      'orca-ide',
      '/opt/bin/custom-orca',
      '"/opt/Orca Dev/orca"',
      'wsl.exe --distribution Ubuntu --exec /opt/bin/orca'
    ])('recognizes the exact %s preamble', (cli) => {
      const task = '  Keep task whitespace\n=== TASK ===\n'
      const preamble = version(cli)
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
    })

    it('leaves plain messages and near misses intact', () => {
      const preamble = version('orca')
      for (const text of [
        '',
        'Do the task\n=== TASK ===\n',
        '  orca automations warn --key "example"\nDo the task',
        `prefix\n${preamble}task`,
        `${preamble.replace('current run', 'another run')}task`,
        `${preamble.replace('orca automations fail', 'orca-dev automations fail')}task`,
        `${preamble.replace('=== TASK ===\n', '=== TASK ===')}task`,
        `${preamble.replaceAll('\n', '\r\n')}task`
      ]) {
        expect(splitAutomationRunMessage(text)).toBeNull()
      }
    })
  }
)

it('splits the current writer output', () => {
  expect(splitAutomationRunMessage(`${buildAutomationRunPreamble('orca')}Task`)?.task).toBe('Task')
})
