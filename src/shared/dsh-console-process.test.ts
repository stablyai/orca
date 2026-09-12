import { expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

it.each([
  'dsh --profile dsh-console --prompt "hello"',
  'node /opt/node_modules/@deepseek-ai/dsh/lib/bin.js --profile dsh-console --resume session',
  String.raw`node C:\npm\node_modules\@deepseek-ai\dsh\lib\bin.js --profile=dsh-console`,
  'dsh --patch /tmp/extra.yml --profile dsh-console',
  'dsh --profile other --profile dsh-console'
])('recognizes the Console profile child: %s', (command) => {
  expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
    agent: 'dsh-console',
    processName: 'dsh-console'
  })
})

it.each([
  'dsh',
  'dsh --profile web',
  'dsh plugin --profile dsh-console add example',
  'dsh --profile dsh-console --profile other',
  'dsh --profile dsh-console --dump-config',
  'dsh --prompt "--profile dsh-console"',
  'node /tmp/bin.js --profile dsh-console',
  'node /tmp/server.js dsh --profile dsh-console'
])('does not claim generic DSH or prompt text: %s', (command) => {
  expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
})
