import { expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

it.each([
  'doubao.exe',
  'node "C:/Program Files/node_modules/@bytedance/doubao-cli/scripts/run.cjs"'
])('only recognizes an interactive Doubao foreground behind %s', (launcher) => {
  const recognize = (args: string) => recognizeAgentProcessFromCommandLine(launcher + args)?.agent
  expect(recognize(' -C "my project" --resume 123')).toBe('doubao')
  expect(recognize(' -C "my project" --resume 123 -p -')).toBeUndefined()
  expect(recognize(' --service-start')).toBeUndefined()
  expect(recognize(' auth status --verify')).toBeUndefined()
  expect(recognize(' --resume')).toBeUndefined()
})
