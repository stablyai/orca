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
import type { TuiAgent } from './tui-agent'

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'

describe('resolveTuiAgentLaunchArgs', () => {
  it('puts the bypass flag in front of the extra arguments in Yolo', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', { agentDefaultArgs: { claude: '--model opus' } })
    ).toBe(`${CLAUDE_BYPASS} --model opus`)
    expect(resolveTuiAgentLaunchArgs('claude', {})).toBe(CLAUDE_BYPASS)
  })

  // The bug behind #23853: custom Arguments used to *be* the permission setting, so typing a model
  // into them silently turned Yolo off while the switch still read Yolo.
  it('keeps the flag when the user adds their own arguments', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentPermissionMode: 'bypass',
        agentDefaultArgs: { claude: '--model opus' }
      })
    ).toContain(CLAUDE_BYPASS)
  })

  it('leaves the flag off in Manual, globally or for one agent', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentPermissionMode: 'ask',
        agentDefaultArgs: { claude: '--model opus' }
      })
    ).toBe('--model opus')
    expect(
      resolveTuiAgentLaunchArgs('codex', {
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: { codex: 'ask' }
      })
    ).toBe('')
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentPermissionMode: 'ask',
        agentPermissionModeOverrides: { claude: 'bypass' }
      })
    ).toBe(CLAUDE_BYPASS)
  })

  it('does not repeat a flag the extra arguments already carry', () => {
    expect(
      resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: `-m o3 ${CODEX_BYPASS}` } })
    ).toBe(`-m o3 ${CODEX_BYPASS}`)
  })

  // Codex refuses its bypass flag beside `-a`, so typed permission options decide on their own.
  it('lets permission options typed into the arguments decide instead of the mode', () => {
    expect(
      resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: '-a on-request' } })
    ).toBe('-a on-request')
    expect(resolveTuiAgentLaunchArgs('claude', {}, '--permission-mode plan')).toBe(
      '--permission-mode plan'
    )
    expect(
      resolveTuiAgentLaunchArgs('claude', {}, '--append-system-prompt "--permission-mode plan"')
    ).toBe(`${CLAUDE_BYPASS} --append-system-prompt "--permission-mode plan"`)
  })

  it.each([
    ['gemini', '--approval-mode auto_edit'],
    ['qwen-code', '-y'],
    ['codex', '-anever'],
    ['codex', '-sread-only']
  ] as const)('adds no flag beside %s permission text %j', (agent, args) => {
    expect(resolveTuiAgentLaunchArgs(agent, { agentDefaultArgs: { [agent]: args } })).toBe(args)
  })

  // #23853's symptom: this option only permits bypass, so Yolo must still add the flag.
  it('adds the flag beside Claude --allow-dangerously-skip-permissions in Yolo', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentDefaultArgs: { claude: '--allow-dangerously-skip-permissions' }
      })
    ).toBe(`${CLAUDE_BYPASS} --allow-dangerously-skip-permissions`)
  })

  // Devin's trust switch rides along with its bypass flag (#21925); the user's own value wins.
  it("keeps the user's Devin --respect-workspace-trust instead of adding a second one", () => {
    expect(
      resolveTuiAgentLaunchArgs('devin', {
        agentDefaultArgs: { devin: '--respect-workspace-trust true' }
      })
    ).toBe('--permission-mode bypass --respect-workspace-trust true')
    expect(
      resolveTuiAgentLaunchArgs('devin', {
        agentPermissionMode: 'ask',
        agentDefaultArgs: { devin: '--respect-workspace-trust true' }
      })
    ).toBe('--respect-workspace-trust true')
    expect(resolveTuiAgentLaunchArgs('devin', {})).toBe(
      '--permission-mode bypass --respect-workspace-trust false'
    )
  })

  // `--search` is a long option, not `-s` with a value attached.
  it('keeps Yolo beside Codex --search', () => {
    expect(resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: '--search' } })).toBe(
      `${CODEX_BYPASS} --search`
    )
  })

  // One settings string reaches POSIX, PowerShell and cmd hosts.
  it('treats an option any launch grammar sees as setting permissions', () => {
    expect(resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: '^-a never' } })).toBe(
      '^-a never'
    )
  })

  it('applies the mode to per-launch extra arguments, and null means none', () => {
    const settings = { agentDefaultArgs: { codex: '--model stored' } }
    expect(resolveTuiAgentLaunchArgs('codex', settings, '--model recipe')).toBe(
      `${CODEX_BYPASS} --model recipe`
    )
    expect(resolveTuiAgentLaunchArgs('codex', settings, null)).toBe(CODEX_BYPASS)
    expect(resolveTuiAgentLaunchArgs('codex', settings, undefined)).toBe(
      `${CODEX_BYPASS} --model stored`
    )
  })

  it('passes arguments through for an agent with no bypass flag', () => {
    expect(resolveTuiAgentLaunchArgs('pi', { agentDefaultArgs: { pi: '--foo' } })).toBe('--foo')
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
    expect(liftTuiAgentBypassArgs('claude', args)).toEqual({ bypass, extraArgs })
  })

  // Lossless: a launch adds no flag beside text that sets permissions, so the flag must stay in it.
  it('keeps the flag in text that also sets permissions another way', () => {
    expect(liftTuiAgentBypassArgs('claude', `${CLAUDE_BYPASS} --permission-mode plan`)).toEqual({
      bypass: true,
      extraArgs: `${CLAUDE_BYPASS} --permission-mode plan`
    })
  })

  // The POSIX grammar cannot parse a Windows path ending in a backslash before its closing quote.
  it('lifts the flag from Windows-quoted text', () => {
    expect(
      liftTuiAgentBypassArgs('claude', `${CLAUDE_BYPASS} --add-dir "C:\\Users\\me\\"`)
    ).toEqual({
      bypass: true,
      extraArgs: '--add-dir "C:\\Users\\me\\"'
    })
  })

  // POSIX parses this but reads the backslash as escaping the space, hiding the flag.
  it('lifts the flag after a Windows path that POSIX mis-splits', () => {
    expect(liftTuiAgentBypassArgs('claude', `--settings C:\\cfg\\ ${CLAUDE_BYPASS}`)).toEqual({
      bypass: true,
      extraArgs: '--settings C:\\cfg\\'
    })
  })

  it('lifts a multi-word bypass flag only as a whole', () => {
    expect(liftTuiAgentBypassArgs('grok', '--permission-mode bypassPermissions -v')).toEqual({
      bypass: true,
      extraArgs: '-v'
    })
    expect(liftTuiAgentBypassArgs('grok', '--permission-mode plan')).toEqual({
      bypass: false,
      extraArgs: '--permission-mode plan'
    })
    expect(liftTuiAgentBypassArgs('continue', '--allow "*"')).toEqual({
      bypass: true,
      extraArgs: ''
    })
  })

  // Lossless: a quoted span is never cut out, so the prompt keeps its value.
  it('leaves a quoted flag value in place', () => {
    expect(liftTuiAgentBypassArgs('claude', `--append-system-prompt "${CLAUDE_BYPASS}"`)).toEqual({
      bypass: true,
      extraArgs: `--append-system-prompt "${CLAUDE_BYPASS}"`
    })
    expect(
      liftTuiAgentBypassArgs('claude', `--append-system-prompt "${CLAUDE_BYPASS}" ${CLAUDE_BYPASS}`)
    ).toEqual({
      bypass: true,
      extraArgs: `--append-system-prompt "${CLAUDE_BYPASS}" ${CLAUDE_BYPASS}`
    })
    expect(liftTuiAgentBypassArgs('claude', `"${CLAUDE_BYPASS}"`)).toEqual({
      bypass: true,
      extraArgs: `"${CLAUDE_BYPASS}"`
    })
  })

  it("lifts Devin's flag around the user's own trust value, and only when it is whole", () => {
    expect(
      liftTuiAgentBypassArgs('devin', '--permission-mode bypass --respect-workspace-trust true')
    ).toEqual({ bypass: true, extraArgs: '--respect-workspace-trust true' })
    expect(
      liftTuiAgentBypassArgs(
        'devin',
        '--model x --respect-workspace-trust false --permission-mode bypass'
      )
    ).toEqual({ bypass: true, extraArgs: '--model x' })
    // Never launched with the trust switch, so lifting would add it.
    expect(liftTuiAgentBypassArgs('devin', '--permission-mode bypass')).toEqual({
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
    expect(liftTuiAgentBypassArgs(agent, args)).toEqual({ bypass: true, extraArgs: args })
  })

  it('leaves untokenizable text alone', () => {
    expect(liftTuiAgentBypassArgs('codex', `"${CODEX_BYPASS}`)).toEqual({
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
    expect(classifyTypedAgentPermissions(agent, { args }).kind).toBe(kind)
    for (const mode of ['bypass', 'ask'] as const) {
      const settings = { agentPermissionMode: mode, agentDefaultArgs: { [agent]: args } }
      const launch = resolveTuiAgentLaunchArgs(agent, settings)
      const flagAdded = launch !== args
      expect(flagAdded).toBe(kind === 'none' && mode === 'bypass')
      expect(resolveAgentPermissionPosture(agent, settings, 'darwin').effectiveBypass).toBe(
        kind === 'none' ? mode === 'bypass' : kind === 'bypass'
      )
    }
  })

  it("reads every agent's own bypass flag as bypass", () => {
    for (const agent of PERMISSION_AGENT_IDS.filter(
      (id): id is TuiAgent => YOLO_TUI_AGENT_ARGS[id] !== undefined
    )) {
      expect(classifyTypedAgentPermissions(agent, { args: YOLO_TUI_AGENT_ARGS[agent] }).kind).toBe(
        'bypass'
      )
    }
  })

  it('reads a typed Goose mode env', () => {
    expect(classifyTypedAgentPermissions('goose', { env: { GOOSE_MODE: 'auto' } })).toEqual({
      kind: 'bypass',
      options: ['GOOSE_MODE=auto']
    })
    expect(classifyTypedAgentPermissions('goose', { env: { GOOSE_MODE: 'approve' } }).kind).toBe(
      'other'
    )
    expect(classifyTypedAgentPermissions('goose', { env: { A: '1' } }).kind).toBe('none')
  })
})

describe('resolveAgentPermissionPosture', () => {
  it('reports the mode and no argument options for a plain profile', () => {
    expect(resolveAgentPermissionPosture('claude', {}, 'darwin')).toEqual({
      mode: 'bypass',
      effectiveBypass: true,
      typedPermissionOptions: []
    })
    expect(
      resolveAgentPermissionPosture('claude', { agentPermissionMode: 'ask' }, 'darwin')
    ).toMatchObject({ mode: 'ask', effectiveBypass: false })
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
        'darwin'
      )
    ).toEqual({ mode: 'ask', effectiveBypass: true, typedPermissionOptions: [CLAUDE_BYPASS] })
  })

  it('lists other permission options without treating them as bypass', () => {
    expect(
      resolveAgentPermissionPosture(
        'claude',
        { agentPermissionMode: 'ask', agentDefaultArgs: { claude: '--permission-mode=auto' } },
        'darwin'
      )
    ).toEqual({
      mode: 'ask',
      effectiveBypass: false,
      typedPermissionOptions: ['--permission-mode=auto']
    })
    expect(
      resolveAgentPermissionPosture(
        'codex',
        { agentPermissionMode: 'ask', agentDefaultArgs: { codex: '-a never -s workspace-write' } },
        'darwin'
      ).typedPermissionOptions
    ).toEqual(['-a never', '-s workspace-write'])
  })

  // A typed env key overrides the mode's env at launch (see resolveTuiAgentLaunchEnv).
  it('reads a typed Goose mode env as the posture', () => {
    expect(
      resolveAgentPermissionPosture(
        'goose',
        { agentPermissionMode: 'bypass', agentDefaultEnv: { goose: { GOOSE_MODE: 'approve' } } },
        'darwin'
      )
    ).toEqual({
      mode: 'bypass',
      effectiveBypass: false,
      typedPermissionOptions: ['GOOSE_MODE=approve']
    })
    expect(
      resolveAgentPermissionPosture(
        'goose',
        { agentPermissionMode: 'ask', agentDefaultEnv: { goose: { GOOSE_MODE: 'auto' } } },
        'darwin'
      ).effectiveBypass
    ).toBe(true)
  })

  it('reports typed permission options overriding Yolo', () => {
    expect(
      resolveAgentPermissionPosture(
        'codex',
        { agentPermissionMode: 'bypass', agentDefaultArgs: { codex: '-a on-request' } },
        'darwin'
      )
    ).toEqual({ mode: 'bypass', effectiveBypass: false, typedPermissionOptions: ['-a on-request'] })
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
        { agentPermissionMode: 'ask', agentDefaultArgs: { [agent]: args } },
        'linux'
      ).effectiveBypass
    ).toBe(false)
  })

  it('reads typed arguments with the configured local Windows shell', () => {
    expect(
      resolveAgentPermissionPosture(
        'claude',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude: `\`${CLAUDE_BYPASS}` },
          terminalWindowsShell: 'powershell.exe'
        },
        'win32'
      ).effectiveBypass
    ).toBe(true)
    expect(
      resolveAgentPermissionPosture(
        'codex',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { codex: `^${CODEX_BYPASS}` },
          terminalWindowsShell: 'cmd.exe'
        },
        'win32'
      ).effectiveBypass
    ).toBe(true)
  })
})

describe('launch-ready records', () => {
  it('publishes every agent with its flag inline, and reads such a record back', () => {
    const record = composeTuiAgentLaunchArgsRecord({
      agentPermissionMode: 'bypass',
      agentPermissionModeOverrides: { codex: 'ask' },
      agentDefaultArgs: { claude: '--model opus', codex: '-m o3' }
    })
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
