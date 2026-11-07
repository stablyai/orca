import { describe, expect, it } from 'vitest'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-status/process/agent-process-recognition'

// Real argv of an npm/bun OmO pane: `omo` execs bun on senpi's generic bundle.
const BUN_OMO =
  '/Users/dev/.bun/bin/bun /Users/dev/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js --extension /Users/dev/.bun/install/global/node_modules/omo-ai/plugin'

describe('OmO agent identity', () => {
  it('recognizes OmO by its binary and versioned runtime path', () => {
    expect(recognizeAgentProcess('omo')).toEqual({ agent: 'omo', processName: 'omo' })
    expect(recognizeAgentProcess('/Users/dev/.omo/binary-runtime/5.1.33/omo')).toEqual({
      agent: 'omo',
      processName: 'omo'
    })
    expect(recognizeAgentProcessFromCommandLine('omo -- "--print the release notes"')).toEqual({
      agent: 'omo',
      processName: 'omo'
    })
  })

  it('does not recognize OmO headless runs as interactive agents', () => {
    expect(recognizeAgentProcessFromCommandLine('omo -p "summarize this diff"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('omo --mode rpc')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('omo --mode json')).toBeNull()
  })

  it('recognizes the senpi build as OmO and filters its headless runs', () => {
    expect(recognizeAgentProcess('senpi')).toEqual({ agent: 'omo', processName: 'senpi' })
    expect(recognizeAgentProcessFromCommandLine('senpi -- "fix the build"')).toEqual({
      agent: 'omo',
      processName: 'senpi'
    })
    expect(recognizeAgentProcessFromCommandLine('senpi -p "summarize this diff"')).toBeNull()
  })

  it('recognizes the bun-run senpi bundle that npm OmO installs', () => {
    expect(recognizeAgentProcessFromCommandLine(BUN_OMO)).toEqual({
      agent: 'omo',
      processName: 'omo'
    })
    expect(recognizeAgentProcessFromCommandLine(`${BUN_OMO} --mode rpc`)).toBeNull()
  })

  it('does not treat ordinary bun scripts as agents', () => {
    expect(recognizeAgentProcessFromCommandLine('bun run dev')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bun ./scripts/build.js')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('bun /tmp/app/dist/bundle/cli.js')).toBeNull()
  })
})
