import { afterEach, expect, it } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { parse } from 'jsonc-parser'
import { registerOpenCodeTuiPlugin } from './opencode-tui-config-registration'
import { writeOpenCodeTuiPlugin } from './opencode-tui-plugin-install'

const pluginSource = `const ORCA_STATUS_AGENT = "opencode";
async function setupLegacyOpenCodeTui() {}
async function setupOpenCode2Status() {}
export default async function server() {}
`

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function root() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-legacy-tui-config-')))
  roots.push(dir)
  return dir
}

it('installs the 1.x object TUI entry and explicitly registers its file URL', () => {
  const configDir = root()
  const plugins = join(configDir, 'plugins')
  writeOpenCodeTuiPlugin(plugins, 'orca-opencode-status.js', pluginSource)
  const entry = join(plugins, 'orca-opencode-status-tui', 'tui.js')
  expect(readFileSync(entry, 'utf8')).toContain('tui: setupLegacyOpenCodeTui')
  expect(readFileSync(entry, 'utf8')).toContain('const orcaServerPlugin =')
  expect(parse(readFileSync(join(configDir, 'tui.json'), 'utf8'))).toEqual({
    plugin: [pathToFileURL(entry).href]
  })
})

it('retains the existing TUI setup and metadata without exposing the server entry', () => {
  const configDir = root()
  const plugins = join(configDir, 'plugins')
  const source = `${pluginSource.replace(/^export default .*$/m, '')}
function mainServer() { return 'main server'; }
function mainSetup() { return 'main setup'; }
export default { id: 'main-owned-id', server: mainServer, setup: mainSetup, unowned: { keep: true } };
`
  writeOpenCodeTuiPlugin(plugins, 'orca-opencode-status.js', source)
  const entry = join(plugins, 'orca-opencode-status-tui', 'tui.js')
  const module: { exports: unknown } = { exports: null }
  runInNewContext(readFileSync(entry, 'utf8').replace(/^export default /m, 'module.exports = '), {
    module
  })
  expect(module.exports).toMatchObject({
    id: 'main-owned-id',
    setup: expect.any(Function),
    tui: expect.any(Function),
    unowned: { keep: true }
  })
  const exported = module.exports
  if (
    !exported ||
    typeof exported !== 'object' ||
    !('setup' in exported) ||
    typeof exported.setup !== 'function'
  ) {
    throw new Error('Missing main-owned plugin entries')
  }
  expect(exported).not.toHaveProperty('server')
  expect(exported.setup()).toBe('main setup')
})

it('preserves existing settings, comments, plugin options and package specifiers', () => {
  const dir = root()
  const entry = join(dir, 'plugins', 'orca', 'tui.js')
  const configPath = join(dir, 'tui.jsonc')
  writeFileSync(
    configPath,
    '{\n  // user choice\n  "theme": "custom",\n  "plugin": ["user-package", ["./custom.js", {"enabled": true}],],\n  "keybinds": {"session_new": "ctrl+n"},\n}\n'
  )
  registerOpenCodeTuiPlugin(dir, entry, 'canonical')
  const text = readFileSync(configPath, 'utf8')
  expect(text).toContain('// user choice')
  expect(parse(text)).toEqual({
    theme: 'custom',
    plugin: ['user-package', ['./custom.js', { enabled: true }], pathToFileURL(entry).href],
    keybinds: { session_new: 'ctrl+n' }
  })
})

it('leaves current TUI source and registration timestamps unchanged', () => {
  const dir = root()
  const plugins = join(dir, 'plugins')
  const source = pluginSource
  writeOpenCodeTuiPlugin(plugins, 'orca-opencode-status.js', source)
  const entry = join(plugins, 'orca-opencode-status-tui', 'tui.js')
  const config = join(dir, 'tui.json')
  const before = [statSync(entry).mtimeMs, statSync(config).mtimeMs]
  writeOpenCodeTuiPlugin(plugins, 'orca-opencode-status.js', source)
  expect([statSync(entry).mtimeMs, statSync(config).mtimeMs]).toEqual(before)
  writeFileSync(config, '{}\n')
  writeOpenCodeTuiPlugin(plugins, 'orca-opencode-status.js', source)
  expect(parse(readFileSync(config, 'utf8')).plugin).toEqual([pathToFileURL(entry).href])
  expect(statSync(entry).mtimeMs).toBe(before[0])
})

it.each(['{broken', '[]', '{"plugin": "user-package"}'])(
  'refuses invalid config without replacing it: %s',
  (text) => {
    const dir = root()
    const config = join(dir, 'tui.json')
    writeFileSync(config, text)
    expect(() => registerOpenCodeTuiPlugin(dir, join(dir, 'tui.js'), 'canonical')).toThrow(
      'Cannot register'
    )
    expect(readFileSync(config, 'utf8')).toBe(text)
  }
)

it.skipIf(process.platform === 'win32')('keeps canonical TUI settings symlinks intact', () => {
  const dir = root()
  const user = join(dir, 'user.json')
  const configDir = join(dir, 'config')
  mkdirSync(configDir)
  writeFileSync(user, '{"theme":"user-theme"}')
  const config = join(configDir, 'tui.json')
  symlinkSync(user, config)
  const entry = join(configDir, 'tui.js')
  registerOpenCodeTuiPlugin(configDir, entry, 'canonical')
  expect(lstatSync(config).isSymbolicLink()).toBe(true)
  expect(parse(readFileSync(user, 'utf8'))).toEqual({
    theme: 'user-theme',
    plugin: [pathToFileURL(entry).href]
  })
})

it.skipIf(process.platform === 'win32')(
  'detaches overlay settings and rebases relative string and tuple plugins',
  () => {
    const dir = root()
    const userDir = join(dir, 'user')
    const configDir = join(dir, 'overlay')
    mkdirSync(userDir)
    mkdirSync(configDir)
    const user = join(userDir, 'tui.jsonc')
    const text =
      '{\n// keep\n"theme":"custom","plugin":["./first.js",["../second.js",{"option":1}],"npm-package"]\n}\n'
    writeFileSync(user, text)
    const config = join(configDir, 'tui.jsonc')
    symlinkSync(user, config)
    const entry = join(configDir, 'plugins', 'orca', 'tui.js')
    registerOpenCodeTuiPlugin(configDir, entry, 'overlay')
    expect(lstatSync(config).isFile()).toBe(true)
    expect(readFileSync(user, 'utf8')).toBe(text)
    const result = readFileSync(config, 'utf8')
    expect(result).toContain('// keep')
    expect(parse(result)).toEqual({
      theme: 'custom',
      plugin: [
        pathToFileURL(join(userDir, 'first.js')).href,
        [pathToFileURL(join(dir, 'second.js')).href, { option: 1 }],
        'npm-package',
        pathToFileURL(entry).href
      ]
    })
  }
)
