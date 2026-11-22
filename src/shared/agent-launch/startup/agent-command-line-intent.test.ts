import { expect, it } from 'vitest'
import { recognizeAgentLaunchCommand } from './agent-command-line-intent'

it("recognizes a PowerShell launch of a quoted program path, such as Orca's own copy", () => {
  expect(
    recognizeAgentLaunchCommand("& 'C:\\Users\\a b\\orca\\claude.exe' --resume 'x'")?.agent
  ).toBe('claude')
})
