import { describe, expect, it } from 'vitest'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import {
  isOmpRpcCatalogAgent,
  isOmpRpcExecutableCommand,
  mergeOmpRpcCommands,
  ompRpcExecutableCommands,
  selectOmpRpcLiveCommands
} from './omp-rpc-command-catalog'

const STATIC = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'help', description: 'Show available commands' }
] as const

describe('mergeOmpRpcCommands', () => {
  it('falls back to the static catalog when the probe returned nothing', () => {
    expect(mergeOmpRpcCommands(STATIC, null)).toBe(STATIC)
    expect(mergeOmpRpcCommands(STATIC, [])).toBe(STATIC)
  })

  it('prefers the live entry for a name the static catalog also has', () => {
    const merged = mergeOmpRpcCommands(STATIC, [
      { name: 'help', description: 'Live help text' },
      { name: 'usage', description: 'Show account usage' }
    ])
    expect(merged).toEqual([
      { name: 'help', description: 'Live help text' },
      { name: 'usage', description: 'Show account usage' },
      { name: 'clear', description: 'Clear the conversation' }
    ])
  })

  it('keeps static commands the live catalog omits, so enabling RPC never shrinks the menu', () => {
    const names = mergeOmpRpcCommands(STATIC, [{ name: 'usage' }]).map((command) => command.name)
    expect(names).toEqual(['usage', 'clear', 'help'])
  })

  it('strips a leading slash and folds the input hint into the description', () => {
    expect(
      mergeOmpRpcCommands(
        [],
        [{ name: '/model', description: 'Pick a model', input: { hint: '<name>' } }]
      )
    ).toEqual([{ name: 'model', description: 'Pick a model — <name>' }])
    expect(mergeOmpRpcCommands([], [{ name: 'side', input: { hint: '<topic>' } }])).toEqual([
      { name: 'side', description: '<topic>' }
    ])
  })

  it('omits the description entirely when the live entry has none', () => {
    expect(mergeOmpRpcCommands([], [{ name: 'usage' }])).toEqual([{ name: 'usage' }])
  })

  it('drops live names that are not a single safe token', () => {
    // The name IS the token typed into the PTY, so wire text can never be
    // sanitized into one; an unsafe name is dropped, not repaired.
    const unsafe: OmpRpcSlashCommand[] = [
      { name: 'two words' },
      { name: '' },
      { name: '/' },
      { name: 'bell' },
      { name: 'x'.repeat(201) },
      { name: 'safe' }
    ]
    expect(mergeOmpRpcCommands([], unsafe)).toEqual([{ name: 'safe' }])
  })

  it('keeps the first entry when the live catalog repeats a name', () => {
    expect(
      mergeOmpRpcCommands(
        [],
        [
          { name: 'usage', description: 'first' },
          { name: 'usage', description: 'second' }
        ]
      )
    ).toEqual([{ name: 'usage', description: 'first' }])
  })

  it('falls back to static when every live name was rejected', () => {
    expect(mergeOmpRpcCommands(STATIC, [{ name: 'two words' }])).toBe(STATIC)
  })

  it('merges a large live catalog without truncating (the picker caps rendering)', () => {
    const live = Array.from({ length: 487 }, (_, index) => ({ name: `cmd${index}` }))
    expect(mergeOmpRpcCommands(STATIC, live)).toHaveLength(489)
  })
})

describe('ompRpcExecutableCommands', () => {
  it('treats a missing or empty catalog as unknown rather than empty', () => {
    expect(ompRpcExecutableCommands(null)).toBeNull()
    expect(ompRpcExecutableCommands([])).toBeNull()
  })

  it('collects names and aliases, since OMP dispatches both through one lookup', () => {
    const executable = ompRpcExecutableCommands([
      { name: '/help', aliases: ['h', '?'], source: 'builtin' },
      { name: 'skill:review', source: 'skill' }
    ])
    expect([...(executable?.names ?? [])].sort()).toEqual(['?', 'h', 'help', 'skill:review'])
  })

  it('marks only builtin names and aliases colon-splittable, the sole source OMP splits', () => {
    // parseSlashCommand (helpers/parse.ts:22-36) cuts at the first whitespace OR
    // colon and only the builtin lookup uses it; extension, custom, MCP-prompt
    // and file commands are looked up on the whole pre-whitespace token
    // (agent-session.ts:6194, :6303, slash-commands.ts:122-126).
    const executable = ompRpcExecutableCommands([
      { name: 'model', aliases: ['models'], source: 'builtin' },
      { name: 'deploy', source: 'extension' },
      { name: 'ship', source: 'custom' },
      { name: 'brief', source: 'mcp_prompt' },
      { name: 'plan', source: 'file' },
      { name: 'skill:review', source: 'skill' },
      { name: 'legacy' }
    ])
    expect([...(executable?.colonSplitNames ?? [])].sort()).toEqual(['model', 'models'])
  })
})

describe('isOmpRpcExecutableCommand', () => {
  const names = ompRpcExecutableCommands([
    { name: 'help', source: 'builtin' },
    { name: 'model', source: 'builtin' },
    { name: 'memory', source: 'builtin' },
    { name: 'skill:review', source: 'skill' }
  ])

  it('accepts a catalog command with and without arguments', () => {
    expect(isOmpRpcExecutableCommand('/help', names)).toBe(true)
    expect(isOmpRpcExecutableCommand('/model opus', names)).toBe(true)
    // A builtin subcommand is whitespace-separated, so the name is still the head.
    expect(isOmpRpcExecutableCommand('/memory mm list', names)).toBe(true)
  })

  it('rejects a command the catalog omits, which is how OMP reports TUI-only builtins', () => {
    // available-commands.ts skips any builtin without a text-mode `handle`, so
    // /clear (handleTui only, builtin-lifecycle.ts:120-129) never appears and
    // RPC cannot run it. Anything else this session did not publish is refused
    // on the same proof-first rule.
    expect(isOmpRpcExecutableCommand('/clear', names)).toBe(false)
    expect(isOmpRpcExecutableCommand('/usage', names)).toBe(false)
  })

  it('rejects unknown slash text, which OMP would hand to the model verbatim', () => {
    expect(isOmpRpcExecutableCommand('/definitely-not-a-command', names)).toBe(false)
    expect(isOmpRpcExecutableCommand('/', names)).toBe(false)
    expect(isOmpRpcExecutableCommand('hello', names)).toBe(false)
  })

  it('matches OMP case-sensitively, because its lookup table is a plain Map', () => {
    expect(isOmpRpcExecutableCommand('/HELP', names)).toBe(false)
  })

  it('keeps the full token for a skill and the pre-colon head for a builtin', () => {
    // parseSlashCommand splits the name at the first colon OR whitespace, so
    // `/model:opus` resolves to builtin `model`; skills keep `skill:<name>`.
    expect(isOmpRpcExecutableCommand('/skill:review', names)).toBe(true)
    expect(isOmpRpcExecutableCommand('/model:opus', names)).toBe(true)
    expect(isOmpRpcExecutableCommand('/skill:missing', names)).toBe(false)
  })

  it('refuses a colon-namespaced invocation of a non-builtin command', () => {
    // OMP looks an extension/custom/MCP/file command up by the whole
    // pre-whitespace token (agent-session.ts:6194), so `/deploy:prod` misses
    // `deploy` entirely and the text would reach the model as a prompt.
    const catalog = ompRpcExecutableCommands([
      { name: 'deploy', source: 'extension' },
      { name: 'ship', source: 'custom' },
      { name: 'plan', source: 'file' }
    ])
    expect(isOmpRpcExecutableCommand('/deploy', catalog)).toBe(true)
    expect(isOmpRpcExecutableCommand('/deploy:prod', catalog)).toBe(false)
    expect(isOmpRpcExecutableCommand('/ship:now', catalog)).toBe(false)
    expect(isOmpRpcExecutableCommand('/plan:v2', catalog)).toBe(false)
  })

  it('splits on a builtin alias too, because the lookup resolves aliases', () => {
    const catalog = ompRpcExecutableCommands([
      { name: 'model', aliases: ['models'], source: 'builtin' }
    ])
    expect(isOmpRpcExecutableCommand('/models:opus', catalog)).toBe(true)
  })

  it('refuses the colon head when the catalog does not say the command is builtin', () => {
    // An OMP old enough to publish the ACP projection (toAcpAvailableCommands)
    // carries no `source`, so builtin-ness is unproven and the head match is
    // refused; the bare name still routes and the probe/PTY paths still apply.
    const catalog = ompRpcExecutableCommands([{ name: 'model' }])
    expect(isOmpRpcExecutableCommand('/model', catalog)).toBe(true)
    expect(isOmpRpcExecutableCommand('/model:opus', catalog)).toBe(false)
  })

  it('cannot prove executability against an unknown or empty catalog, so it refuses', () => {
    // Routing to the session is a claim that OMP will *run* the command. Until
    // a catalog proves it, `/clear` would reach session.prompt and fall through
    // to the model instead of reporting that it needs a live terminal.
    const empty = { names: new Set<string>(), colonSplitNames: new Set<string>() }
    for (const catalog of [null, undefined, empty]) {
      expect(isOmpRpcExecutableCommand('/clear', catalog)).toBe(false)
      expect(isOmpRpcExecutableCommand('/help', catalog)).toBe(false)
    }
  })
})

describe('isOmpRpcCatalogAgent', () => {
  it('is true only for OMP panes and tolerates an unresolved agent', () => {
    expect(isOmpRpcCatalogAgent('omp')).toBe(true)
    expect(isOmpRpcCatalogAgent('claude')).toBe(false)
    expect(isOmpRpcCatalogAgent(null)).toBe(false)
  })
})

describe('selectOmpRpcLiveCommands', () => {
  const sessionCommands: OmpRpcSlashCommand[] = [{ name: 'reloaded-skill' }]
  const probeCommands: OmpRpcSlashCommand[] = [{ name: 'help' }, { name: 'model' }]

  it("prefers the owning session's catalog over the cwd-cached probe snapshot", () => {
    // The probe is fetched once per cwd and cached for the app's life, so a
    // skill or extension command the session registered later never shows up in
    // it. The session republishes available_commands_update on every change.
    expect(selectOmpRpcLiveCommands(sessionCommands, probeCommands)).toBe(sessionCommands)
  })

  it('keeps the probe snapshot while no session has published a catalog', () => {
    // A pane with no RPC session (or one whose catalog has not arrived) is
    // exactly the case the probe exists for.
    for (const absent of [null, undefined, []]) {
      expect(selectOmpRpcLiveCommands(absent, probeCommands)).toBe(probeCommands)
    }
  })

  it('reports no live catalog when neither source has one', () => {
    // Null, not empty: mergeOmpRpcCommands reads it as "unknown" and keeps the
    // static menu rather than emptying the `/` picker.
    expect(selectOmpRpcLiveCommands(null, null)).toBeNull()
    expect(selectOmpRpcLiveCommands([], [])).toBeNull()
  })
})
