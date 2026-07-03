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
})
