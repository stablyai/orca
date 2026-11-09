import { describe, expect, it } from 'vitest'
import {
  isExpectedAgentProcess,
  isRecognizedAgentType,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-status/process/agent-process-recognition'

describe('IBM Bob process recognition', () => {
  it('recognizes IBM Bob across platform-specific process paths', () => {
    expect(recognizeAgentProcess('/usr/local/bin/bob')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(recognizeAgentProcess(String.raw`C:\Users\dev\AppData\Roaming\npm\bob.cmd`)).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(isExpectedAgentProcess('/usr/local/bin/bob', 'bob')).toBe(true)
    expect(isRecognizedAgentType('bob')).toBe(true)
  })

  it('does not recognize IBM Bob one-shot commands as interactive agents', () => {
    // Why: Bob Shell 2.x runs `-p/--prompt` and `run` headless; `mcp`, `--list-tasks`
    // and the info flags print and exit.
    expect(recognizeAgentProcessFromCommandLine('bob -p "summarize this diff"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob -psummarize')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob --prompt "review this"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob --prompt=review')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob run "review this"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob run --format json review')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob mcp list')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob --list-tasks')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob --list-tasks all')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob -v')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob --show-license')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bob -- review this')).toBeNull()
  })

  it('recognizes IBM Bob chat launches as interactive agents', () => {
    expect(recognizeAgentProcessFromCommandLine('bob')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(recognizeAgentProcessFromCommandLine('bob chat')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(recognizeAgentProcessFromCommandLine('bob chat --trust --auto-approve')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(recognizeAgentProcessFromCommandLine('bob chat --mode plan -w /repo')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    // Why: `--resume [task-id]` takes an optional value that must not read as a prompt.
    expect(recognizeAgentProcessFromCommandLine('bob --resume')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(recognizeAgentProcessFromCommandLine('bob -r abc123')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(recognizeAgentProcessFromCommandLine('bob chat -r abc123')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
    expect(recognizeAgentProcessFromCommandLine('bob --accept-license')).toEqual({
      agent: 'bob',
      processName: 'bob'
    })
  })

  it('filters wrapped IBM Bob one-shot commands without dropping interactive shells', () => {
    expect(
      recognizeAgentProcessFromCommandLine('node /Users/dev/.nvm/versions/node/bin/bob run review')
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\bob.cmd --prompt review`
      )
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\bob.cmd chat --trust`
      )
    ).toEqual({ agent: 'bob', processName: 'bob' })
    // Why: the npm install runs the bundle directly, so the script path is the only bob token.
    expect(
      recognizeAgentProcessFromCommandLine(
        'node /Users/dev/.nvm/versions/node/v26.5.1/lib/node_modules/bobshell/dist/bob.js chat'
      )
    ).toEqual({ agent: 'bob', processName: 'bob' })
    expect(
      recognizeAgentProcessFromCommandLine(
        'node /Users/dev/.nvm/versions/node/v26.5.1/lib/node_modules/bobshell/dist/bob.js -p review'
      )
    ).toBeNull()
    // Why: the package marker needs a segment boundary, the same rule the headless
    // matcher applies, so a look-alike directory is neither Bob nor a Bob one-shot.
    expect(
      recognizeAgentProcessFromCommandLine('node /repo/fake-node_modules/bobshell/dist/bob.js chat')
    ).toBeNull()
  })
})
