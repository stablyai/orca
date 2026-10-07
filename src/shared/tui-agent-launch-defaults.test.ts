import { describe, expect, it } from 'vitest'
import {
  composeTuiAgentLaunchArgsRecord,
  resolveComposedTuiAgentLaunchArgs,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import {
  classifyTypedAgentPermissions,
  resolveAgentPermissionPosture
} from './tui-agent-permission-args'
import { liftTuiAgentBypassArgs, liftTuiAgentBypassEnv } from './tui-agent-bypass-lift'
import { PERMISSION_AGENT_IDS, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

const DARWIN = { platform: 'darwin' } as const

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'

describe('resolveTuiAgentLaunchArgs', () => {
  it('puts the bypass flag in front of the extra arguments in Yolo', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', { agentDefaultArgs: { claude: '--model opus' } }, DARWIN)
    ).toBe(`${CLAUDE_BYPASS} --model opus`)
    expect(resolveTuiAgentLaunchArgs('claude', {}, DARWIN)).toBe(CLAUDE_BYPASS)
  })

  // The bug behind #23853: custom Arguments used to *be* the permission setting, so typing a model
  // into them silently turned Yolo off while the switch still read Yolo.
  it('keeps the flag when the user adds their own arguments', () => {
    expect(
      resolveTuiAgentLaunchArgs(
        'claude',
        {
          agentPermissionMode: 'bypass',
          agentDefaultArgs: { claude: '--model opus' }
        },
        DARWIN
      )
    ).toContain(CLAUDE_BYPASS)
  })

  it('leaves the flag off in Manual, globally or for one agent', () => {
    expect(
      resolveTuiAgentLaunchArgs(
        'claude',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude: '--model opus' }
        },
        DARWIN
      )
    ).toBe('--model opus')
    expect(
      resolveTuiAgentLaunchArgs(
        'codex',
        {
          agentPermissionMode: 'bypass',
          agentPermissionModeOverrides: { codex: 'ask' }
        },
        DARWIN
      )
    ).toBe('')
    expect(
      resolveTuiAgentLaunchArgs(
        'claude',
        {
          agentPermissionMode: 'ask',
          agentPermissionModeOverrides: { claude: 'bypass' }
        },
        DARWIN
      )
    ).toBe(CLAUDE_BYPASS)
  })

  it('does not repeat a flag the extra arguments already carry', () => {
    expect(
      resolveTuiAgentLaunchArgs(
        'codex',
        { agentDefaultArgs: { codex: `-m o3 ${CODEX_BYPASS}` } },
        DARWIN
      )
    ).toBe(`-m o3 ${CODEX_BYPASS}`)
  })

  // Codex refuses its bypass flag beside `-a`, so typed permission options decide on their own.
  it('lets permission options typed into the arguments decide instead of the mode', () => {
    expect(
      resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: '-a on-request' } }, DARWIN)
    ).toBe('-a on-request')
    expect(resolveTuiAgentLaunchArgs('claude', {}, DARWIN, '--permission-mode plan')).toBe(
      '--permission-mode plan'
    )
    expect(
      resolveTuiAgentLaunchArgs(
        'claude',
        {},
        DARWIN,
        '--append-system-prompt "--permission-mode plan"'
      )
    ).toBe(`${CLAUDE_BYPASS} --append-system-prompt "--permission-mode plan"`)
  })

  it.each([
    ['gemini', '--approval-mode auto_edit'],
    ['qwen-code', '-y'],
    ['codex', '-anever'],
    ['codex', '-sread-only']
  ] as const)('adds no flag beside %s permission text %j', (agent, args) => {
    expect(resolveTuiAgentLaunchArgs(agent, { agentDefaultArgs: { [agent]: args } }, DARWIN)).toBe(
      args
    )
  })

  // #23853's symptom: this option only permits bypass, so Yolo must still add the flag.
  it('adds the flag beside Claude --allow-dangerously-skip-permissions in Yolo', () => {
    expect(
      resolveTuiAgentLaunchArgs(
        'claude',
        {
          agentDefaultArgs: { claude: '--allow-dangerously-skip-permissions' }
        },
        DARWIN
      )
    ).toBe(`${CLAUDE_BYPASS} --allow-dangerously-skip-permissions`)
  })

  // Devin's trust switch rides along with its bypass flag (#21925); the user's own value wins.
  it("keeps the user's Devin --respect-workspace-trust instead of adding a second one", () => {
    expect(
      resolveTuiAgentLaunchArgs(
        'devin',
        {
          agentDefaultArgs: { devin: '--respect-workspace-trust true' }
        },
        DARWIN
      )
    ).toBe('--permission-mode bypass --respect-workspace-trust true')
    expect(
      resolveTuiAgentLaunchArgs(
        'devin',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { devin: '--respect-workspace-trust true' }
        },
        DARWIN
      )
    ).toBe('--respect-workspace-trust true')
    expect(resolveTuiAgentLaunchArgs('devin', {}, DARWIN)).toBe(
      '--permission-mode bypass --respect-workspace-trust false'
    )
  })

  // Per-launch text (Source Control, fix-checks) replaces the configured text, not the effective
  // mode the agent's card shows.
  it.each([
    ['codex', '-a on-request', 'bypass', false],
    ['claude', '--permission-mode acceptEdits', 'bypass', false],
    ['gemini', '-y', 'bypass', true],
    ['gemini', '-y', 'ask', true],
    ['claude', '--model opus', 'bypass', true],
    ['claude', '--model opus', 'ask', false]
  ] as const)(
    'gives per-launch text for %s configured %j under %s the flag: %s',
    (agent, configured, mode, flagged) => {
      const settings = { agentPermissionMode: mode, agentDefaultArgs: { [agent]: configured } }
      const launch = resolveTuiAgentLaunchArgs(agent, settings, DARWIN, '--model per-launch')
      expect(launch !== '--model per-launch').toBe(flagged)
      expect(launch.endsWith('--model per-launch')).toBe(true)
    }
  )

  it('adds no flag beside per-launch text that sets permissions itself', () => {
    expect(
      resolveTuiAgentLaunchArgs(
        'gemini',
        { agentDefaultArgs: { gemini: '-y' } },
        DARWIN,
        '--approval-mode default'
      )
    ).toBe('--approval-mode default')
  })

  // `--search` is a long option, not `-s` with a value attached.
  it('keeps Yolo beside Codex --search', () => {
    expect(
      resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: '--search' } }, DARWIN)
    ).toBe(`${CODEX_BYPASS} --search`)
  })

  // One settings string reaches POSIX, PowerShell and cmd hosts.
  // Read with the launch's own shell: cmd strips `^`, so only there is `^-a` the -a option.
  it('reads the extra text with the shell that launches it', () => {
    const settings = { agentDefaultArgs: { codex: '^-a never' } }
    expect(resolveTuiAgentLaunchArgs('codex', settings, { platform: 'win32', shell: 'cmd' })).toBe(
      '^-a never'
    )
    expect(resolveTuiAgentLaunchArgs('codex', settings, DARWIN)).toBe(`${CODEX_BYPASS} ^-a never`)
  })

  it('applies the mode to per-launch extra arguments, and null means none', () => {
    const settings = { agentDefaultArgs: { codex: '--model stored' } }
    expect(resolveTuiAgentLaunchArgs('codex', settings, DARWIN, '--model recipe')).toBe(
      `${CODEX_BYPASS} --model recipe`
    )
    expect(resolveTuiAgentLaunchArgs('codex', settings, DARWIN, null)).toBe(CODEX_BYPASS)
    expect(resolveTuiAgentLaunchArgs('codex', settings, DARWIN, undefined)).toBe(
      `${CODEX_BYPASS} --model stored`
    )
  })

  it('passes arguments through for an agent with no bypass flag', () => {
    expect(resolveTuiAgentLaunchArgs('pi', { agentDefaultArgs: { pi: '--foo' } }, DARWIN)).toBe(
      '--foo'
    )
  })
})

describe('resolveTuiAgentLaunchEnv', () => {
  it('applies an env-driven bypass under the user env in Yolo only', () => {
    expect(resolveTuiAgentLaunchEnv('goose', { agentDefaultEnv: { goose: { A: '1' } } })).toEqual({
      GOOSE_MODE: 'auto',
      A: '1'
    })
    expect(
      resolveTuiAgentLaunchEnv('goose', {
        agentPermissionMode: 'ask',
        agentDefaultEnv: { goose: { A: '1' } }
      })
    ).toEqual({ A: '1' })
  })
})

describe('liftTuiAgentBypassArgs', () => {
  it.each([
    [CLAUDE_BYPASS, true, ''],
    [`${CLAUDE_BYPASS} --model Opus`, true, '--model Opus'],
    [`--model Opus ${CLAUDE_BYPASS}`, true, '--model Opus'],
    [`--model Opus ${CLAUDE_BYPASS} --effort high`, true, '--model Opus --effort high'],
    [`${CLAUDE_BYPASS} ${CLAUDE_BYPASS}`, true, ''],
    ['', false, ''],
    ['--model Opus', false, '--model Opus'],
    [`${CLAUDE_BYPASS}-not-really`, false, `${CLAUDE_BYPASS}-not-really`],
    [
      `--append-system-prompt "mention ${CLAUDE_BYPASS} only as text"`,
      false,
      `--append-system-prompt "mention ${CLAUDE_BYPASS} only as text"`
    ],
    [`-- ${CLAUDE_BYPASS}`, false, `-- ${CLAUDE_BYPASS}`],
    // The rest of the text keeps its own quoting byte for byte.
    [
      `${CLAUDE_BYPASS} --append-system-prompt 'be "brief"'`,
      true,
      `--append-system-prompt 'be "brief"'`
    ]
  ] as const)('lifts claude %j to bypass=%s with %j left', (args, bypass, extraArgs) => {
    expect(liftTuiAgentBypassArgs('claude', args, DARWIN)).toEqual({ bypass, extraArgs })
  })

  // Lossless: a launch adds no flag beside text that sets permissions, so the flag must stay in it.
  it('keeps the flag in text that also sets permissions another way', () => {
    expect(
      liftTuiAgentBypassArgs('claude', `${CLAUDE_BYPASS} --permission-mode plan`, DARWIN)
    ).toEqual({
      bypass: true,
      extraArgs: `${CLAUDE_BYPASS} --permission-mode plan`
    })
  })

  // POSIX reads these differently (it can't parse the first, and glues the path onto the flag in
  // the second), so no cut is the same under every shell: the text stays whole and this machine's
  // shell reads it, which is still how it launched.
  it.each([
    `${CLAUDE_BYPASS} --add-dir "C:\\Users\\me\\"`,
    `--settings C:\\cfg\\ ${CLAUDE_BYPASS}`
  ])('keeps the flag in %j and reads it with the local shell', (args) => {
    const windows = { platform: 'win32', shell: 'powershell' } as const
    expect(liftTuiAgentBypassArgs('claude', args, windows)).toEqual({
      bypass: true,
      extraArgs: args
    })
    expect(liftTuiAgentBypassArgs('claude', args, DARWIN)).toEqual({
      bypass: false,
      extraArgs: args
    })
  })

  it('lifts a multi-word bypass flag only as a whole', () => {
    expect(
      liftTuiAgentBypassArgs('grok', '--permission-mode bypassPermissions -v', DARWIN)
    ).toEqual({
      bypass: true,
      extraArgs: '-v'
    })
    expect(liftTuiAgentBypassArgs('grok', '--permission-mode plan', DARWIN)).toEqual({
      bypass: false,
      extraArgs: '--permission-mode plan'
    })
    expect(liftTuiAgentBypassArgs('continue', '--allow "*"', DARWIN)).toEqual({
      bypass: true,
      extraArgs: ''
    })
  })

  // Lossless: a quoted span is never cut out, so the prompt keeps its value.
  it('leaves a quoted flag value in place', () => {
    expect(
      liftTuiAgentBypassArgs('claude', `--append-system-prompt "${CLAUDE_BYPASS}"`, DARWIN)
    ).toEqual({
      bypass: true,
      extraArgs: `--append-system-prompt "${CLAUDE_BYPASS}"`
    })
    expect(
      liftTuiAgentBypassArgs(
        'claude',
        `--append-system-prompt "${CLAUDE_BYPASS}" ${CLAUDE_BYPASS}`,
        DARWIN
      )
    ).toEqual({
      bypass: true,
      extraArgs: `--append-system-prompt "${CLAUDE_BYPASS}" ${CLAUDE_BYPASS}`
    })
    expect(liftTuiAgentBypassArgs('claude', `"${CLAUDE_BYPASS}"`, DARWIN)).toEqual({
      bypass: true,
      extraArgs: `"${CLAUDE_BYPASS}"`
    })
  })

  it("lifts Devin's flag around the user's own trust value, and only when it is whole", () => {
    expect(
      liftTuiAgentBypassArgs(
        'devin',
        '--permission-mode bypass --respect-workspace-trust true',
        DARWIN
      )
    ).toEqual({ bypass: true, extraArgs: '--respect-workspace-trust true' })
    expect(
      liftTuiAgentBypassArgs(
        'devin',
        '--model x --respect-workspace-trust false --permission-mode bypass',
        DARWIN
      )
    ).toEqual({ bypass: true, extraArgs: '--model x' })
    // Never launched with the trust switch, so lifting would add it.
    expect(liftTuiAgentBypassArgs('devin', '--permission-mode bypass', DARWIN)).toEqual({
      bypass: true,
      extraArgs: '--permission-mode bypass'
    })
  })

  // Lossless: an alias stays in the text, but the agent reads as Yolo, which is how it launches.
  it.each([
    ['gemini', '-y'],
    ['claude', '--permission-mode bypassPermissions --model x'],
    ['devin', '--permission-mode bypass --model x'],
    ['codex', '-a never -s danger-full-access']
  ] as const)('keeps the %s bypass alias %j inline as bypass', (agent, args) => {
    expect(liftTuiAgentBypassArgs(agent, args, DARWIN)).toEqual({ bypass: true, extraArgs: args })
  })

  it('leaves untokenizable text alone', () => {
    expect(liftTuiAgentBypassArgs('codex', `"${CODEX_BYPASS}`, DARWIN)).toEqual({
      bypass: false,
      extraArgs: `"${CODEX_BYPASS}`
    })
  })
})

describe('liftTuiAgentBypassEnv', () => {
  it('lifts the bypass env out and keeps the rest', () => {
    expect(liftTuiAgentBypassEnv('goose', { GOOSE_MODE: 'auto', A: '1' })).toEqual({
      bypass: true,
      extraEnv: { A: '1' }
    })
    expect(liftTuiAgentBypassEnv('goose', { GOOSE_MODE: 'approve' })).toEqual({
      bypass: false,
      extraEnv: { GOOSE_MODE: 'approve' }
    })
  })
})

// Launch, Settings, structured sessions and the migration read Arguments through one classifier,
// so what Settings shows can't disagree with what the agent launches with.
describe('classifyTypedAgentPermissions', () => {
  it.each([
    ['grok', '--permission-mode bypassPermissions', true],
    ['grok', '--model grok-4.7 --permission-mode bypassPermissions', true],
    ['grok', '--permission-mode default', false],
    ['grok', '--permission-mode', false],
    ['grok', '--permission-mode "bypassPermissions now"', false],
    ['grok', '-- --permission-mode bypassPermissions', false],
    ['devin', '--permission-mode bypass --respect-workspace-trust false', true],
    // The trust switch is a companion; bypass alone still sets Devin's permissions.
    ['devin', '--permission-mode bypass', true]
  ] as const)('reads the %s permission sequence %j as bypass=%s', (agent, args, bypass) => {
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      expect(classifyTypedAgentPermissions(agent, { args }, shell).kind === 'bypass').toBe(bypass)
    }
  })

  it.each([
    ['claude', '--permission-mode bypassPermissions', 'bypass'],
    ['claude', '--permission-mode=bypassPermissions', 'bypass'],
    ['claude', `${CLAUDE_BYPASS} --permission-mode bypassPermissions`, 'bypass'],
    ['claude', '--permission-mode acceptEdits', 'other'],
    ['openclaude', '--permission-mode bypassPermissions --model x', 'bypass'],
    ['devin', '--permission-mode bypass --model swe-1.5', 'bypass'],
    ['devin', '--permission-mode bypass --respect-workspace-trust true', 'bypass'],
    // Only the folder-trust prompt, not a permission.
    ['devin', '--respect-workspace-trust false', 'none'],
    ['grok', '--permission-mode=bypassPermissions', 'bypass'],
    ['grok', '--permission-mode plan', 'other'],
    ['cline', '--auto-approve=true', 'bypass'],
    ['cline', '--auto-approve false', 'other'],
    ['codex', '--yolo', 'bypass'],
    ['codex', '-a never -s danger-full-access', 'bypass'],
    ['codex', '-s danger-full-access -a never', 'bypass'],
    ['codex', '--sandbox danger-full-access --ask-for-approval never', 'bypass'],
    ['codex', '--ask-for-approval=never --sandbox=danger-full-access', 'bypass'],
    ['codex', '-anever -sdanger-full-access', 'bypass'],
    ['codex', '-a never', 'other'],
    ['codex', '-a never -s workspace-write', 'other'],
    ['codex', '--full-auto', 'other'],
    ['gemini', '-y', 'bypass'],
    ['gemini', '--approval-mode yolo', 'bypass'],
    ['gemini', '--approval-mode=yolo', 'bypass'],
    ['gemini', '--approval-mode auto_edit', 'other'],
    ['qwen-code', '-y', 'bypass'],
    ['qwen-code', '--yolo', 'bypass'],
    ['continue', '--allow "*"', 'bypass'],
    ['continue', '--allow Read', 'other'],
    // Only allows a later switch into bypass, so the mode still decides.
    ['claude', '--allow-dangerously-skip-permissions --model opus', 'none'],
    // The launch strips quotes before the CLI sees them, so a quoted option is still one.
    ['codex', '"-a" on-request', 'other'],
    ['codex', '"--ask-for-approval=on-request"', 'other'],
    ['codex', `"${CODEX_BYPASS}"`, 'bypass'],
    ['claude', '"--permission-mode=bypassPermissions"', 'bypass'],
    // Known limit: the CLI reads this as the prompt's value, but it is read as the flag.
    ['claude', `--append-system-prompt "${CLAUDE_BYPASS}"`, 'bypass'],
    ['claude', `-- ${CLAUDE_BYPASS}`, 'none'],
    ['claude', '--model opus', 'none']
  ] as const)('reads %s %j as %s, and launch and Settings agree', (agent, args, kind) => {
    expect(classifyTypedAgentPermissions(agent, { args }, 'posix').kind).toBe(kind)
    for (const mode of ['bypass', 'ask'] as const) {
      const settings = { agentPermissionMode: mode, agentDefaultArgs: { [agent]: args } }
      const launch = resolveTuiAgentLaunchArgs(agent, settings, DARWIN)
      const flagAdded = launch !== args
      expect(flagAdded).toBe(kind === 'none' && mode === 'bypass')
      expect(resolveAgentPermissionPosture(agent, settings, DARWIN).effectiveBypass).toBe(
        kind === 'none' ? mode === 'bypass' : kind === 'bypass'
      )
    }
  })

  it("reads every agent's own bypass flag as bypass", () => {
    for (const agent of PERMISSION_AGENT_IDS.filter(
      (id): id is TuiAgent => YOLO_TUI_AGENT_ARGS[id] !== undefined
    )) {
      expect(
        classifyTypedAgentPermissions(agent, { args: YOLO_TUI_AGENT_ARGS[agent] }, 'posix').kind
      ).toBe('bypass')
    }
  })

  it('reads a typed Goose mode env', () => {
    expect(
      classifyTypedAgentPermissions('goose', { env: { GOOSE_MODE: 'auto' } }, 'posix')
    ).toEqual({
      kind: 'bypass',
      argumentOptions: [],
      environmentOptions: ['GOOSE_MODE=auto']
    })
    expect(
      classifyTypedAgentPermissions('goose', { env: { GOOSE_MODE: 'approve' } }, 'posix').kind
    ).toBe('other')
    expect(classifyTypedAgentPermissions('goose', { env: { A: '1' } }, 'posix').kind).toBe('none')
  })
})

describe('resolveAgentPermissionPosture', () => {
  it.each(Object.keys(YOLO_TUI_AGENT_ARGS).filter(isTuiAgent))(
    "reads the toggle's own Yolo and Manual writes for %s",
    (agent) => {
      for (const platform of ['darwin', 'win32'] as const) {
        for (const agentPermissionMode of ['bypass', 'ask'] as const) {
          const settings = { agentPermissionMode }
          const target = { platform }
          const bypass = agentPermissionMode === 'bypass'
          expect(resolveAgentPermissionPosture(agent, settings, target).effectiveBypass).toBe(
            bypass
          )
          const args = resolveTuiAgentLaunchArgs(agent, settings, target)
          expect(
            classifyTypedAgentPermissions(
              agent,
              { args },
              platform === 'win32' ? 'powershell' : 'posix'
            ).kind
          ).toBe(bypass ? 'bypass' : 'none')
          const lifted = liftTuiAgentBypassArgs(agent, args, target)
          expect(lifted).toEqual({ bypass, extraArgs: '' })
        }
      }
    }
  )

  it('reports the mode and no argument options for a plain profile', () => {
    expect(resolveAgentPermissionPosture('claude', {}, DARWIN)).toEqual({
      mode: 'bypass',
      effectiveBypass: true,
      typedArgumentOptions: [],
      typedEnvironmentOptions: []
    })
    expect(
      resolveAgentPermissionPosture('claude', { agentPermissionMode: 'ask' }, DARWIN)
    ).toMatchObject({
      mode: 'ask',
      effectiveBypass: false
    })
  })

  // Settings warns instead of letting the switch silently lose to free text.
  it('reports a bypass flag typed into Arguments under Manual', () => {
    expect(
      resolveAgentPermissionPosture(
        'claude',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude: `--model Opus ${CLAUDE_BYPASS}` }
        },
        DARWIN
      )
    ).toEqual({
      mode: 'ask',
      effectiveBypass: true,
      typedArgumentOptions: [CLAUDE_BYPASS],
      typedEnvironmentOptions: []
    })
  })

  it('lists other permission options without treating them as bypass', () => {
    expect(
      resolveAgentPermissionPosture(
        'claude',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude: '--permission-mode=auto' }
        },
        DARWIN
      )
    ).toEqual({
      mode: 'ask',
      effectiveBypass: false,
      typedArgumentOptions: ['--permission-mode=auto'],
      typedEnvironmentOptions: []
    })
    expect(
      resolveAgentPermissionPosture(
        'codex',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { codex: '-a never -s workspace-write' }
        },
        DARWIN
      ).typedArgumentOptions
    ).toEqual(['-a never', '-s workspace-write'])
  })

  // A typed env key overrides the mode's env at launch (see resolveTuiAgentLaunchEnv).
  it('reads a typed Goose mode env as the posture', () => {
    expect(
      resolveAgentPermissionPosture(
        'goose',
        {
          agentPermissionMode: 'bypass',
          agentDefaultEnv: { goose: { GOOSE_MODE: 'approve' } }
        },
        DARWIN
      )
    ).toEqual({
      mode: 'bypass',
      effectiveBypass: false,
      typedArgumentOptions: [],
      typedEnvironmentOptions: ['GOOSE_MODE=approve']
    })
    expect(
      resolveAgentPermissionPosture(
        'goose',
        {
          agentPermissionMode: 'ask',
          agentDefaultEnv: { goose: { GOOSE_MODE: 'auto' } }
        },
        DARWIN
      ).effectiveBypass
    ).toBe(true)
  })

  it('reports typed permission options overriding Yolo', () => {
    expect(
      resolveAgentPermissionPosture(
        'codex',
        {
          agentPermissionMode: 'bypass',
          agentDefaultArgs: { codex: '-a on-request' }
        },
        DARWIN
      )
    ).toEqual({
      mode: 'bypass',
      effectiveBypass: false,
      typedArgumentOptions: ['-a on-request'],
      typedEnvironmentOptions: []
    })
  })

  it.each([
    ['claude', `--append-system-prompt "mention ${CLAUDE_BYPASS} only as text"`],
    ['claude', `-- ${CLAUDE_BYPASS}`],
    ['codex', `--config "note=${CODEX_BYPASS} only as text"`],
    ['codex', `-- ${CODEX_BYPASS}`],
    ['codex', `"${CODEX_BYPASS}`]
  ] as const)('does not authorize %s text %j', (agent, args) => {
    expect(
      resolveAgentPermissionPosture(
        agent,
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { [agent]: args }
        },
        DARWIN
      ).effectiveBypass
    ).toBe(false)
  })
})

describe('launch-ready records', () => {
  it('publishes every agent with its flag inline, and reads such a record back', () => {
    const record = composeTuiAgentLaunchArgsRecord(
      {
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: { codex: 'ask' },
        agentDefaultArgs: { claude: '--model opus', codex: '-m o3' }
      },
      DARWIN
    )
    expect(record.claude).toBe(`${CLAUDE_BYPASS} --model opus`)
    expect(record.codex).toBe('-m o3')
    expect(resolveComposedTuiAgentLaunchArgs('claude', record)).toBe(
      `${CLAUDE_BYPASS} --model opus`
    )
    // A record that predates an agent meant "the shipped default" for it.
    expect(resolveComposedTuiAgentLaunchArgs('claude', {})).toBe(CLAUDE_BYPASS)
    expect(resolveComposedTuiAgentLaunchArgs('claude', { claude: '' })).toBe('')
  })
})
