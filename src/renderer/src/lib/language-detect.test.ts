import { describe, expect, it } from 'vitest'
import { detectLanguage } from './language-detect'

describe('detectLanguage', () => {
  it('maps .vue files to the custom vue language id', () => {
    expect(detectLanguage('src/components/App.vue')).toBe('vue')
  })

  it('maps .svelte files to the custom svelte language id', () => {
    expect(detectLanguage('src/components/Widget.svelte')).toBe('svelte')
  })

  it('maps .astro files to the custom astro language id', () => {
    expect(detectLanguage('src/routes/index.astro')).toBe('astro')
  })

  it('maps Nim files to the nim language id', () => {
    expect(detectLanguage('src/main.nim')).toBe('nim')
    expect(detectLanguage('tasks/build.nims')).toBe('nim')
    expect(detectLanguage('packages/app.nimble')).toBe('nim')
  })

  it('maps exact filenames from Windows paths', () => {
    expect(detectLanguage('C:\\Users\\alice\\repo\\Dockerfile')).toBe('dockerfile')
    expect(detectLanguage('C:\\Users\\alice\\repo\\CMakeLists.txt')).toBe('cmake')
  })

  it('maps Windows Batch files to Monaco built-in Batch language id', () => {
    expect(detectLanguage('scripts/setup.bat')).toBe('bat')
    expect(detectLanguage('C:\\repo\\scripts\\bootstrap.CMD')).toBe('bat')
  })

  it('maps SystemVerilog and Verilog files to their Monaco language ids', () => {
    expect(detectLanguage('rtl/cpu.sv')).toBe('systemverilog')
    expect(detectLanguage('rtl/pkg.svh')).toBe('systemverilog')
    expect(detectLanguage('rtl/alu.v')).toBe('verilog')
    expect(detectLanguage('rtl/defs.vh')).toBe('verilog')
    expect(detectLanguage('C:\\rtl\\TOP.SV')).toBe('systemverilog')
  })

  it('maps .proto files to the Monaco built-in proto language id, not the alias', () => {
    expect(detectLanguage('api/v1/service.proto')).toBe('proto')
  })

  it('maps .jsonl files to the dedicated jsonl language id (case-insensitive)', () => {
    expect(detectLanguage('/home/user/.claude/sessions/transcript.jsonl')).toBe('jsonl')
    expect(detectLanguage('C:\\Users\\alice\\.codex\\LOG.JSONL')).toBe('jsonl')
  })

  it('maps .cts/.mts files to the Monaco built-in typescript language id (case-insensitive)', () => {
    expect(detectLanguage('config/vitest.config.mts')).toBe('typescript')
    expect(detectLanguage('scripts/postinstall.cts')).toBe('typescript')
    expect(detectLanguage('types/global.d.mts')).toBe('typescript')
    expect(detectLanguage('C:\\repo\\config\\BUILD.MTS')).toBe('typescript')
  })

  it('keeps .mjs/.cjs on the Monaco built-in javascript language id', () => {
    expect(detectLanguage('scripts/build.mjs')).toBe('javascript')
    expect(detectLanguage('scripts/legacy.cjs')).toBe('javascript')
  })

  it('maps .r files to the r language id regardless of case', () => {
    expect(detectLanguage('analysis/model.r')).toBe('r')
    expect(detectLanguage('analysis/MODEL.R')).toBe('r')
  })

  it('keeps .json/.jsonc on the built-in json language and unknown on plaintext', () => {
    expect(detectLanguage('config/settings.json')).toBe('json')
    expect(detectLanguage('config/tsconfig.jsonc')).toBe('json')
    expect(detectLanguage('notes/scratch.unknownext')).toBe('plaintext')
  })

  it('maps the whole dotenv family to the ini language id (case-insensitive)', () => {
    expect(detectLanguage('.env')).toBe('ini')
    expect(detectLanguage('apps/api/.env.local')).toBe('ini')
    expect(detectLanguage('.env.functions.local')).toBe('ini')
    expect(detectLanguage('.env.staging.example')).toBe('ini')
    expect(detectLanguage('C:\\repo\\.env.production')).toBe('ini')
    expect(detectLanguage('.ENV')).toBe('ini')
    expect(detectLanguage('.ENV.STAGING')).toBe('ini')
  })

  it('maps compose-style env_file names to the ini language id', () => {
    expect(detectLanguage('deploy/dev.env')).toBe('ini')
    expect(detectLanguage('C:\\repo\\docker.env')).toBe('ini')
  })

  it('keeps extension mapping ahead of the dotenv fallback', () => {
    expect(detectLanguage('scripts/.env.sh')).toBe('shell')
    expect(detectLanguage('config/.env.json')).toBe('json')
  })

  it('does not treat non-dotenv dotfiles as dotenv', () => {
    expect(detectLanguage('.envrc')).toBe('plaintext')
    expect(detectLanguage('.environment')).toBe('plaintext')
  })
})
