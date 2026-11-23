import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from '../../../agent-launch/startup/tui-agent-launch-command'
import { tokenizeStartupCommand } from '../../../agent-launch/startup/tui-agent-startup-shell'
import { grayModelLaunchArgs, parseGrayModelList } from './gray-model-list-probe'

describe('Gray model discovery and launch', () => {
  it('keeps identical model IDs distinct across providers and skips bad or duplicate rows', () => {
    const model = { id: 'vendor/model', name: 'Model', current: true }
    const rows = parseGrayModelList(
      JSON.stringify({
        version: 1,
        providers: [
          { id: 'custom:local', name: 'Local', active: true, models: [model, model, null] },
          { id: 'other', models: [model] },
          null
        ]
      })
    )
    expect(rows).toEqual([
      {
        id: '["custom:local","vendor/model"]',
        label: 'Model',
        description: 'Local',
        isDefault: true
      },
      { id: '["other","vendor/model"]', label: 'Model', description: 'other' }
    ])
  })

  it.each([
    'not JSON',
    'null',
    '{"version":2,"providers":[]}',
    '{"version":1,"error":"timeout","providers":[]}'
  ])('ignores an unusable catalog: %s', (stdout) => expect(parseGrayModelList(stdout)).toEqual([]))

  it('passes both exact IDs as Shell-safe Gray arguments and replaces stale flags', () => {
    const model = JSON.stringify(['custom:local', "vendor/name with spaces; '$"])
    const launch = resolveAgentLaunchCommand({
      agent: 'gray',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix',
      agentArgs: '--provider old --model=stale --lean',
      sessionOptions: { model },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(launch.ok && tokenizeStartupCommand(launch.command, 'posix')).toMatchObject({
      tokens: ['gray', '--lean', '--provider=custom:local', "--model=vendor/name with spaces; '$"]
    })
    expect(grayModelLaunchArgs('unqualified')).toEqual([])
  })
})
