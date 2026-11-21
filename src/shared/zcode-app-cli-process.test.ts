import { describe, expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-status/process/agent-process-recognition'

describe('zcode-app-cli process admission', () => {
  it.each([
    'node /usr/local/lib/node_modules/zcode-app-cli/bin/zcode.js --mode yolo',
    'node /usr/local/lib/node_modules/zcode-app-cli/vendor/zcode.cjs --mode yolo',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Example User\\AppData\\Roaming\\npm\\node_modules\\zcode-app-cli\\vendor\\zcode.cjs" --mode yolo'
  ])('recognizes the interactive package entrypoint: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
      agent: 'zcode',
      processName: 'zcode-cli'
    })
  })

  it('keeps plugin hosts out of interactive and headless agent admission', () => {
    const command =
      'node /usr/lib/node_modules/zcode-app-cli/vendor/zcode.cjs __zcode-plugin-host /plugins/server.js'
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(command, { includeHeadlessOneShot: true })
    ).toBeNull()
  })

  it('recognizes print jobs only when explicitly including headless agents', () => {
    const command = 'node /usr/lib/node_modules/zcode-app-cli/vendor/zcode.cjs -p hello'
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(command, { includeHeadlessOneShot: true })).toEqual(
      {
        agent: 'zcode',
        processName: 'zcode-cli'
      }
    )
  })

  it.each([
    'node /usr/lib/node_modules/unrelated/vendor/zcode.cjs',
    'node /usr/lib/node_modules/zcode-app-cli/vendor/other.cjs'
  ])('rejects unrelated package entrypoints: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
  })
})
