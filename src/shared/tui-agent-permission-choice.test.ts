import * as permissionArgs from './agent-permission-args'
import { getDefaultSettings } from './constants'
import { legacyChatPermissionWrite } from '../main/persistence/applying-settings/legacy-chat-permission-write'
import { measureSettingsWork, expectSettingsWorkScale } from './global-settings-test-fixture'
import { buildAgentStartupPlan, buildAgentResumeStartupPlan } from './tui-agent-startup'
import {
  wholeAgentEnvironmentUpdates,
  legacyLaunchTextUpdates
} from './agent-launch-permission-updates'
import { describe, expect, it, vi } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsSource
} from './agent-launch-settings'
import { newChatPermissionModeForSettings } from './agent-chat-permission-mode'
import {
  DEFAULT_TUI_AGENT_ARGS,
  DEFAULT_TUI_AGENT_ENV,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import { applyAllAgentsPermission, resolveAgentPermission } from './tui-agent-permission-choice'
import { agentArgsSetPermission, migrateAgentPermissionChoice } from './tui-agent-permission-lift'

const legacy = (
  args: Record<string, string>,
  env: Record<string, Record<string, string>> = {}
): AgentLaunchSettingsSource => ({
  agentDefaultArgs: { ...DEFAULT_TUI_AGENT_ARGS, ...args },
  agentDefaultEnv: { ...DEFAULT_TUI_AGENT_ENV, ...env }
})

describe('one-time move of permission flags out of Arguments', () => {
  it('imports Grok modes from recorded 1.0.62 help without taking ownership of other modes', () => {
    // Installed 1.0.62 (1474f9cbdd91) --help, permission-mode excerpt; not captured argv.
    const recordedHelp = `      --permission-mode <MODE>
          Permission mode

          [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]`
    const option = recordedHelp.trim().split(' ')[0]
    const modes = recordedHelp.match(/possible values: ([^\]]+)/)?.[1].split(', ')
    expect(modes).toBeDefined()
    for (const mode of modes ?? []) {
      const text = `${option} ${mode} --model grok-code-fast-1`
      const migrated = migrateAgentPermissionChoice({ agentDefaultArgs: { grok: text } })
      const choice =
        mode === 'default' ? 'ask' : mode === 'bypassPermissions' ? 'full-access' : 'own'
      expect(resolveAgentPermission('grok', migrated).choice).toBe(choice)
      expect(migrated.agentDefaultArgs.grok).toBe(
        choice === 'own' ? text : '--model grok-code-fast-1'
      )
      expect(resolveTuiAgentLaunchArgs('grok', migrated)).toBe(text)
    }
  })

  it('turns saved shapes into a stored choice and leaves the rest of the text', () => {
    const migrated = migrateAgentPermissionChoice(
      legacy(
        {
          claude: '--model opus --dangerously-skip-permissions',
          codex: '--approve-for-me -c model_reasoning_effort="high"',
          gemini: '',
          // Not one of Orca's flags: left whole, and Orca adds nothing.
          grok: '--permission-mode plan'
        },
        { goose: { goose_mode: 'auto', OTHER: '1' } }
      ),
      'win32'
    )
    expect(migrated.agentPermissionDefault).toBe('full-access')
    expect(migrated.agentDefaultArgs).toMatchObject({
      claude: '--model opus',
      codex: '-c model_reasoning_effort="high"',
      gemini: '',
      grok: '--permission-mode plan',
      cursor: ''
    })
    // Windows reads env names case-insensitively; unrelated entries stay.
    expect(migrated.agentDefaultEnv.goose).toEqual({ OTHER: '1' })
    expect(migrated.agentPermissionOverrides).toEqual({
      codex: 'auto',
      gemini: 'own',
      grok: 'own',
      opencode: 'own',
      opencode2: 'own',
      omp: 'own'
    })
    // Terminals launch what they launched before the move.
    expect(resolveTuiAgentLaunchArgs('claude', migrated)).toBe(
      '--dangerously-skip-permissions --model opus'
    )
    expect(resolveTuiAgentLaunchArgs('grok', migrated)).toBe('--permission-mode plan')
    expect(resolveTuiAgentLaunchEnv('goose', migrated)).toEqual({ GOOSE_MODE: 'auto', OTHER: '1' })
  })

  it('cuts a flag beside quoted text, and leaves a quoted flag as the user’s own text', () => {
    const migrated = migrateAgentPermissionChoice(
      legacy({ claude: '--name "a b" --dangerously-skip-permissions' })
    )
    expect(migrated.agentDefaultArgs.claude).toBe('--name "a b"')
    const quoted = migrateAgentPermissionChoice(
      legacy({ claude: '"--dangerously-skip-permissions"' })
    )
    expect(quoted.agentPermissionOverrides.claude).toBe('own')
    expect(quoted.agentDefaultArgs.claude).toBe('"--dangerously-skip-permissions"')
  })
})

describe('terminal launch composes the stored choice', () => {
  const typed = {
    agentPermissionDefault: 'full-access',
    agentPermissionOverrides: { claude: 'ask', codex: 'own' },
    agentDefaultArgs: { claude: '--model opus', codex: '--search', grok: '--permission-mode plan' }
  } as const

  it('adds Orca’s flag ahead of the user’s text, nothing for own or text that sets permissions', () => {
    expect(resolveTuiAgentLaunchArgs('claude', typed)).toBe(
      '--permission-mode default --model opus'
    )
    expect(resolveTuiAgentLaunchArgs('codex', typed)).toBe('--search')
    expect(resolveTuiAgentLaunchArgs('grok', typed)).toBe('--permission-mode plan')
    expect(resolveTuiAgentLaunchArgs('gemini', typed)).toBe('--yolo')
    // Stored intent survives; the terminal composes no unsupported recipe.
    expect(resolveTuiAgentLaunchArgs('gemini', { agentPermissionDefault: 'ask' })).toBe('')
  })

  it('passes an older host’s published text through unchanged', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentDefaultArgs: { claude: '--permission-mode auto' }
      })
    ).toBe('--permission-mode auto')
  })

  it('Auto for all agents keeps the others on what they had', () => {
    const next = applyAllAgentsPermission({ agentPermissionDefault: 'full-access' }, 'auto')
    expect(resolveAgentPermission('claude', next).choice).toBe('auto')
    expect(resolveAgentPermission('gemini', next).choice).toBe('full-access')
  })
})

it.each(['typed', 'legacy', 'chat'] as const)(
  'keeps migration-owned and hand-set choices across global writes (%s)',
  (path) => {
    const settings = {
      ...getDefaultSettings('/synthetic'),
      ...migrateAgentPermissionChoice(legacy({ gemini: '', grok: '' }))
    }
    settings.agentPermissionOverrides.codex = 'ask'
    const original = { ...settings.agentPermissionOverrides }
    expect(Object.values(original).filter((value) => value === 'own').length).toBeGreaterThan(1)
    for (const choice of ['ask', 'auto', 'auto', 'full-access'] as const) {
      const mode = choice === 'ask' ? 'manual' : choice === 'auto' ? 'auto' : 'yolo'
      const before = { ...settings.agentPermissionOverrides }
      Object.assign(
        settings,
        path === 'chat'
          ? legacyChatPermissionWrite(settings, { nativeChatPermissionMode: choice })
          : agentLaunchSettingsMutationUpdates(
              settings,
              path === 'legacy' ? { type: 'permissions', mode } : { type: 'permission', choice },
              'linux'
            )
      )
      expect(settings.agentPermissionOverrides).toMatchObject(original)
      expect(settings.agentPermissionOverrides).toMatchObject(before)
    }
    expect(
      applyAllAgentsPermission({ agentPermissionDefault: 'auto' }, 'auto').agentPermissionOverrides
    ).toEqual({})
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permission', agent: 'gemini', choice: 'ask' },
        'linux'
      )
    ).toThrow('This agent does not offer that permission')
  }
)

describe('older clients against a host with the stored choice', () => {
  const host = {
    ...migrateAgentPermissionChoice(legacy({ codex: '--approve-for-me --search' })),
    nativeChatPermissionMode: 'ask'
  } satisfies AgentLaunchSettingsSource

  it('see Arguments with the flag included', () => {
    const projected = projectAgentLaunchSettings(host)
    expect(projected.agentDefaultArgs.codex).toBe('--approve-for-me --search')
    expect(projected.agentPermission?.userArgs.codex).toBe('--search')
  })

  it('deleting the published flag means the agent’s own settings; another flag becomes the choice', () => {
    const deleted = agentLaunchSettingsMutationUpdates(
      host,
      { type: 'arguments', agent: 'codex', value: '--search' },
      'linux'
    )
    expect(resolveAgentPermission('codex', { ...host, ...deleted }).choice).toBe('own')
    const swapped = agentLaunchSettingsMutationUpdates(
      host,
      {
        type: 'arguments',
        agent: 'codex',
        value: '--dangerously-bypass-approvals-and-sandbox --search'
      },
      'linux'
    )
    expect({ ...host, ...swapped }.agentDefaultArgs?.codex).toBe('--search')
    expect(resolveAgentPermission('codex', { ...host, ...swapped }).choice).toBe('full-access')
    const manual = agentLaunchSettingsMutationUpdates(
      host,
      { type: 'permissions', mode: 'manual', agent: 'claude' },
      'linux'
    )
    expect(resolveTuiAgentLaunchArgs('claude', { ...host, ...manual })).toBe('')
  })

  it('new chats start in the stored choice; agents on their own settings delegate their chats too', () => {
    expect(newChatPermissionModeForSettings('codex', host)).toBe('auto')
    const own = { ...host, agentPermissionOverrides: { codex: 'own' as const } }
    expect(newChatPermissionModeForSettings('codex', own)).toBe('own')
  })
})

describe('permission carrier ownership across save, reload and consumers', () => {
  const disagreement = '--model op\\ us --permission-mode auto'
  const repeated = '--dangerously-skip-permissions '.repeat(20).trim()
  const ownershipCases = [
    [
      'claude',
      '--model opus --permission-mode auto',
      '--model opus',
      '--permission-mode auto --model opus',
      'auto',
      true
    ],
    [
      'claude',
      '--permission-mode auto --model opus',
      '--model opus',
      '--permission-mode auto --model opus',
      'auto',
      true
    ],
    [
      'claude',
      '--append-system-prompt --dangerously-skip-permissions',
      '--append-system-prompt --dangerously-skip-permissions',
      '--permission-mode auto --append-system-prompt --dangerously-skip-permissions',
      'auto',
      false
    ],
    [
      'claude',
      '--tools Bash --dangerously-skip-permissions Read',
      '--tools Bash --dangerously-skip-permissions Read',
      '--tools Bash --dangerously-skip-permissions Read',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown value --permission-mode auto',
      '--unknown value --permission-mode auto',
      '--unknown value --permission-mode auto',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown value',
      '--unknown value',
      '--permission-mode auto --unknown value',
      'auto',
      false
    ],
    [
      'claude',
      '-- --dangerously-skip-permissions',
      '-- --dangerously-skip-permissions',
      '--permission-mode auto -- --dangerously-skip-permissions',
      'auto',
      false
    ],
    [
      'claude',
      '--append-system-prompt -- --permission-mode auto',
      '--append-system-prompt --',
      '--permission-mode auto --append-system-prompt --',
      'auto',
      true
    ],
    [
      'claude',
      'resume --permission-mode auto',
      'resume --permission-mode auto',
      'resume --permission-mode auto',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown --append-system-prompt --dangerously-skip-permissions',
      '--unknown --append-system-prompt --dangerously-skip-permissions',
      '--unknown --append-system-prompt --dangerously-skip-permissions',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown -- --dangerously-skip-permissions',
      '--unknown -- --dangerously-skip-permissions',
      '--unknown -- --dangerously-skip-permissions',
      'auto',
      true
    ],
    ['codex', '--yolo', '--yolo', '--yolo', 'auto', true],
    ['codex', '--not-so-yolo', '--not-so-yolo', '--not-so-yolo', 'auto', true],
    ['codex', '--approve-for-me', '', '--approve-for-me', 'auto', true],
    ['codex', '-sread-only', '-sread-only', '-sread-only', 'auto', true],
    ['codex', '-aon-request', '-aon-request', '-aon-request', 'auto', true],
    [
      'codex',
      '-c sandbox_mode="read-only"',
      '-c sandbox_mode="read-only"',
      '-c sandbox_mode="read-only"',
      'auto',
      true
    ],
    [
      'codex',
      '--config approval_policy=on-request',
      '--config approval_policy=on-request',
      '--config approval_policy=on-request',
      'auto',
      true
    ],
    [
      'codex',
      '-capprovals_reviewer=auto_review',
      '-capprovals_reviewer=auto_review',
      '-capprovals_reviewer=auto_review',
      'auto',
      true
    ],
    [
      'codex',
      '--config=sandbox_workspace_write.network_access=true',
      '--config=sandbox_workspace_write.network_access=true',
      '--config=sandbox_workspace_write.network_access=true',
      'auto',
      true
    ],
    [
      'codex',
      '-c model_reasoning_effort=high',
      '-c model_reasoning_effort=high',
      '--approve-for-me -c model_reasoning_effort=high',
      'auto',
      false
    ],
    [
      'codex',
      `-c '"sandbox_mode"=read-only'`,
      `-c '"sandbox_mode"=read-only'`,
      `--approve-for-me -c '"sandbox_mode"=read-only'`,
      'auto',
      false
    ],
    ['claude', repeated, repeated, repeated, 'auto', true],
    ['claude', disagreement, disagreement, disagreement, 'auto', true],
    ['grok', '--yolo', '--yolo', '--yolo', 'ask', true]
  ] as const
  it.each(
    ownershipCases.flatMap(([agent, value, raw, launch, chat, carrier]) =>
      (value.includes('--model opus') || value === repeated ? [20, 200] : [1]).map((n) => {
        const scale = (text: string) =>
          text === repeated
            ? '--dangerously-skip-permissions '.repeat(n).trim()
            : text.replace('--model opus', '--model opus '.repeat(n).trim())
        return [agent, scale(value), scale(raw), scale(launch), chat, carrier, n] as const
      })
    )
  )('%s preserves ownership for %s', (agent, value, raw, launch, chat, carrier, n) => {
    const before: AgentLaunchSettingsSource = {
      agentPermissionDefault: agent === 'grok' ? 'ask' : 'auto'
    }
    const start = [importWork.chars, importWork.visits]
    expect(
      migrateAgentPermissionChoice({ agentDefaultArgs: { [agent]: value } }, 'linux')
        .agentDefaultArgs[agent]
    ).toBe(raw)
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'user-arguments', agent, value },
      'linux'
    )
    const beforeReload = importWork.chars
    const loaded = migrateAgentPermissionChoice(
      JSON.parse(JSON.stringify({ ...before, ...updates })),
      'linux'
    )
    expect(importWork.chars).toBe(beforeReload)
    if (value.length > 100) {
      const key = value.startsWith('--permission-mode')
        ? 'leading'
        : raw === value
          ? 'rejected'
          : 'tail'
      const size = [importWork.chars - start[0], importWork.visits - start[1]]
      expectSettingsWorkScale(`import-${key}`, n, size)
    }
    expect(loaded.agentDefaultArgs[agent]).toBe(raw)
    expect(resolveTuiAgentLaunchArgs(agent, loaded)).toBe(launch)
    expect(projectAgentLaunchSettings(loaded).agentDefaultArgs[agent]).toBe(launch)
    expect(newChatPermissionModeForSettings(agent, loaded)).toBe(chat)
    expect(agentArgsSetPermission(agent, value)).toBe(carrier)
  })

  it('keeps a Gemini mode from recorded 0.63.0 help user-owned through import and composition', () => {
    // Installed 0.63.0 --help, ticket 1916: syntax evidence, without a provider turn.
    const recordedHelp = `      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]`
    const option = recordedHelp.trim().split(/\s+/)[0]
    const mode = recordedHelp.match(/choices: "([^"]+)"/)?.[1]
    const text = `${option} ${mode}`
    expect(text).toBe('--approval-mode default')
    const imported = migrateAgentPermissionChoice({ agentDefaultArgs: { gemini: text } })
    expect(imported.agentDefaultArgs.gemini).toBe(text)
    expect(resolveAgentPermission('gemini', imported).choice).toBe('own')
    const full = { ...imported, agentPermissionDefault: 'full-access' as const }
    expect(resolveAgentPermission('gemini', full).choice).toBe('full-access')
    expect(resolveTuiAgentLaunchArgs('gemini', full)).toBe(text)
  })

  it.each(['--approval-mode auto_edit', '--approval-mode=plan', '-y'])(
    'preserves Gemini literal %s under Full through save and reload',
    (value) => {
      const before: AgentLaunchSettingsSource = { agentPermissionDefault: 'full-access' }
      const updates = agentLaunchSettingsMutationUpdates(
        before,
        { type: 'user-arguments', agent: 'gemini', value },
        'linux'
      )
      const loaded = migrateAgentPermissionChoice(
        JSON.parse(JSON.stringify({ ...before, ...updates })),
        'linux'
      )
      expect(loaded.agentDefaultArgs.gemini).toBe(value)
      expect(loaded.agentPermissionOverrides).toEqual({})
      expect(resolveAgentPermission('gemini', loaded).choice).toBe('full-access')
      expect(resolveTuiAgentLaunchArgs('gemini', loaded)).toBe(value)
      expect(projectAgentLaunchSettings(loaded).agentDefaultArgs.gemini).toBe(value)
      expect(agentArgsSetPermission('gemini', value)).toBe(true)
    }
  )

  it.each(
    (['linux', 'win32'] as const).flatMap((platform) =>
      [20, 200].map((n) => [platform, n] as const)
    )
  )('prepares Goose with ordered semantics on %s (%i)', (platform, n) => {
    const carrierName = (key: string) =>
      (platform === 'win32' ? key.toUpperCase() : key) === 'GOOSE_MODE'
    const aliases = Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        let bit = 0
        return [
          'GOOSE_MODE'.replace(/[A-Z]/g, (c) => (i & (1 << bit++) ? c.toLowerCase() : c)),
          'custom'
        ]
      })
    )
    const ordinary = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        [...'ORDINARYKEY'].map((c, bit) => (i & (1 << bit) ? c.toLowerCase() : c)).join(''),
        'old'
      ])
    )
    const changed = Object.fromEntries(Object.keys(ordinary).map((k) => [k, 'new']))
    const proto = (value: string) => Object.fromEntries([['__proto__', value]])
    for (const [row, [raw, requested, mode = 'full-access']] of (
      [
        [{}, { goose_mode: 'auto' }],
        [
          { GOOSE_MODE: 'a', goose_mode: 'b' },
          { GOOSE_MODE: 'a', goose_mode: 'b', X: 'c' }
        ],
        [{ GOOSE_MODE: 'custom', goose_mode: 'auto', OTHER: 'keep' }, {}],
        [proto('own'), proto('next')],
        [aliases, { ...aliases, X: 'new' }],
        [aliases, {}],
        [aliases, aliases],
        [ordinary, changed, 'ask'],
        [ordinary, { ...changed, GOOSE_MODE: 'auto' }]
      ] as const
    ).entries()) {
      const extras = Object.fromEntries(Array.from({ length: n }, (_, i) => [`Other${i}`, {}]))
      const initial: AgentLaunchSettingsSource = {
        agentPermissionDefault: mode === 'ask' ? 'ask' : 'full-access',
        agentDefaultEnv: { ...extras, goose: raw, gemini: { LATEST: 'keep' } },
        agentPermissionOverrides: Object.fromEntries(
          Object.keys(extras).map((k) => [k, 'own' as const])
        )
      }
      const previous = resolveTuiAgentLaunchEnv('goose', initial, platform)
      const changedNames = [
        ...new Set([...Object.keys(previous), ...Object.keys(requested)])
      ].filter((name) => previous[name] !== requested[name])
      const expectedActions = changedNames.filter(carrierName).length
      const sequential = changedNames.reduce<AgentLaunchSettingsSource>(
        (state, name) => ({
          ...state,
          ...agentLaunchSettingsMutationUpdates(
            state,
            Object.hasOwn(requested, name)
              ? { type: 'environment-set', agent: 'goose', name, value: requested[name] }
              : { type: 'environment-remove', agent: 'goose', name },
            platform
          )
        }),
        initial
      )
      let outer = 0
      type AgentSettingsMap = Record<
        string,
        | Record<string, string>
        | NonNullable<AgentLaunchSettingsSource['agentPermissionDefault']>
        | undefined
      >
      const observe = <T extends AgentSettingsMap>(target: T) =>
        new Proxy(target, {
          ownKeys(value) {
            const keys = Reflect.ownKeys(value)
            outer += 2 * keys.length
            return keys
          },
          get(value, key) {
            outer++
            return typeof key === 'string' ? value[key] : undefined
          }
        })
      initial.agentDefaultEnv = observe(initial.agentDefaultEnv!)
      initial.agentPermissionOverrides = observe(initial.agentPermissionOverrides!)
      const receipt = measureSettingsWork(() =>
        wholeAgentEnvironmentUpdates(initial, 'goose', requested, platform)
      )
      const d = Object.keys(raw).filter(carrierName).length
      expect(outer).toBeLessThanOrEqual(4 * (2 * n + 2))
      const ordinary =
        Object.keys(raw).filter((k) => !carrierName(k)).length +
        Object.keys(requested).filter((k) => !carrierName(k)).length
      expect(receipt.work.assignments).toBe(expectedActions)
      // Removal/rename rows empty the raw carrier group on the first action; later raw groups stay empty.
      const complete =
        row >= 7
          ? 13 * n + 1 + (row === 8 ? 3 * n + 24 : 0)
          : (expectedActions ? 20 * (d + 2 * expectedActions) : 0) + 12 * (d + ordinary + 1)
      const entries = receipt.work.entries + complete
      expect(entries).toBeLessThanOrEqual(
        row >= 7
          ? 36 * (n + (row === 8 ? 1 : 0)) + 64
          : 64 * (d + expectedActions + 1) + 36 * ordinary
      )
      if (row >= 7 && platform === 'win32') {
        expect(receipt.value.agentDefaultEnv?.goose).toEqual({
          [Object.keys(changed).at(-1)!]: 'new'
        })
      }
      const key = `env-${platform}-${row}`,
        counts = [entries + outer, receipt.work.bytes]
      expectSettingsWorkScale(key, n, counts)
      if (row === 6) {
        expect(receipt.value).toEqual({})
      }
      expect(receipt.work.comparisons).toBeLessThanOrEqual(
        16 * (d + 1) * Math.ceil(Math.log2(d + 1))
      )
      const prepared = { ...initial, ...receipt.value }
      expect(prepared).toEqual(sequential)
      expect(Object.keys(prepared.agentDefaultEnv?.goose ?? {})).toEqual(
        Object.keys(sequential.agentDefaultEnv?.goose ?? {})
      )
    }
  })

  it('applies combined old-client carrier edits against the original projection', () => {
    const host: AgentLaunchSettingsSource = {
      agentPermissionDefault: 'full-access',
      agentDefaultEnv: { goose: { KEEP: '1' } }
    }
    const updated = {
      ...host,
      ...legacyLaunchTextUpdates(
        host,
        {
          agentDefaultArgs: { goose: '--model foo', claude: '--permission-mode auto --model opus' },
          agentDefaultEnv: { goose: { GOOSE_MODE: 'auto', KEEP: '2' } }
        },
        'linux'
      )
    }
    expect(resolveTuiAgentLaunchEnv('goose', updated, 'linux')).toEqual({
      GOOSE_MODE: 'auto',
      KEEP: '2'
    })
    expect(resolveTuiAgentLaunchArgs('goose', updated)).toBe('--model foo')
    expect(newChatPermissionModeForSettings('claude', updated)).toBe('auto')
    expect(updated.agentDefaultArgs?.claude).toBe('--model opus')
  })

  it('uses host environment identity without guessing duplicate Windows values', () => {
    const raw = legacy({}, { goose: { goose_mode: 'auto', KEEP: '1' } })
    const posix = migrateAgentPermissionChoice(raw, 'linux')
    expect(resolveTuiAgentLaunchEnv('goose', posix, 'linux')).toEqual({
      goose_mode: 'auto',
      KEEP: '1'
    })
    const explicit = { ...posix, agentPermissionOverrides: { goose: 'full-access' as const } }
    expect(resolveTuiAgentLaunchEnv('goose', explicit, 'linux')).toEqual({
      GOOSE_MODE: 'auto',
      goose_mode: 'auto',
      KEEP: '1'
    })
    const unknown = migrateAgentPermissionChoice(raw, null)
    expect(unknown.agentDefaultEnv.goose).toEqual({ goose_mode: 'auto', KEEP: '1' })
    const windows = migrateAgentPermissionChoice(raw, 'win32')
    expect(resolveTuiAgentLaunchEnv('goose', windows, 'win32')).toEqual({
      GOOSE_MODE: 'auto',
      KEEP: '1'
    })
    const duplicate = migrateAgentPermissionChoice(
      legacy({}, { goose: { GOOSE_MODE: 'auto', goose_mode: 'approve' } }),
      'win32'
    )
    expect(resolveAgentPermission('goose', duplicate).choice).toBe('own')
    expect(resolveTuiAgentLaunchEnv('goose', duplicate, 'win32')).toEqual({
      GOOSE_MODE: 'auto',
      goose_mode: 'approve'
    })
  })

  it('migrates agents without terminal flags to own, then retains explicit chat choices through Auto', () => {
    const agents = ['antigravity', 'opencode', 'opencode2', 'omp'] as const
    const upgraded = {
      ...migrateAgentPermissionChoice(legacy({})),
      nativeChatPermissionMode: 'ask' as const
    }
    for (const agent of ['opencode', 'opencode2', 'omp'] as const) {
      expect(newChatPermissionModeForSettings(agent, upgraded)).toBe('own')
    }
    const ask = { ...upgraded, ...applyAllAgentsPermission(upgraded, 'ask') }
    for (const agent of agents) {
      const expected = agent === 'antigravity' ? 'ask' : 'own'
      expect(resolveTuiAgentLaunchArgs(agent, ask)).toBe('')
      expect(newChatPermissionModeForSettings(agent, ask)).toBe(expected)
      const edited = {
        ...ask,
        ...agentLaunchSettingsMutationUpdates(
          ask,
          { type: 'arguments', agent, value: '--model foo' },
          'linux'
        )
      }
      expect(newChatPermissionModeForSettings(agent, edited)).toBe(expected)
    }
    const own = { ...ask, agentPermissionOverrides: { omp: 'own' as const } }
    const auto = { ...own, ...applyAllAgentsPermission(own, 'auto') }
    expect(resolveAgentPermission('omp', auto).choice).toBe('own')
    for (const agent of ['antigravity', 'opencode', 'opencode2'] as const) {
      expect(newChatPermissionModeForSettings(agent, auto)).toBe('ask')
    }
  })
})

const importWork = { chars: 0, visits: 0 }
const cut = permissionArgs.permissionRecipeCut
vi.spyOn(permissionArgs, 'permissionRecipeCut').mockImplementation((agent, text, recipe) => {
  const { value, work } = measureSettingsWork(() => cut(agent, text, recipe))
  importWork.chars += work.chars
  importWork.visits += work.visits
  if (text.length < 100) {
    return value
  }
  const calls = work.inputs,
    w = recipe.split(' ').length,
    t = text.split(' ').length
  expect(calls.filter((v) => v === text)).toHaveLength(3)
  // Fixed token/span/owner allowance plus native slices and two B construction passes per candidate.
  for (const [actual, bound] of [
    [calls.filter((v) => v.length > 100 && v !== text).length, 3 * (w + 1)],
    [work.chars, 3 * (w + 2) * text.length + 4096],
    [work.entries + work.visits, 3 * (2 + 10 * (w + 1)) * (t + w) + 4096],
    [work.bytes + 2 * (w + 1) * text.length, 12 * (w + 1) * text.length + 4096]
  ]) {
    expect(actual).toBeLessThanOrEqual(bound)
  }
  return value
})
it.each([false, true])('bounds actual startup/raw resume (%s)', (resume) => {
  for (const n of [20, 200]) {
    const models = '--model opus '.repeat(n).trim(),
      raw = Array(n).fill("'--model' 'opus'").join(' ')
    const { value: plan, work } = measureSettingsWork(() =>
      (resume ? buildAgentResumeStartupPlan : buildAgentStartupPlan)({
        agent: 'claude',
        cmdOverrides: {},
        platform: 'linux',
        agentArgs: models,
        sessionOptions: { model: 'opus' },
        sessionOptionsOverrideAgentArgs: resume,
        prompt: '',
        allowEmptyPromptLaunch: true,
        providerSession: { key: 'session_id', id: 's' }
      })
    )
    expect(plan?.launchConfig.agentCommand).toBe(`claude ${raw}`)
    expect(plan?.launchCommand).toBe(`claude ${resume ? "'--model' 'opus' '--resume' 's'" : raw}`)
    expect(work.visits).toBeLessThanOrEqual(40 * (2 * n + 1))
    expectSettingsWorkScale(`startup-${resume}`, n, [work.visits])
  }
})
