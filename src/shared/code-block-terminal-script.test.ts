import { describe, expect, it } from 'vitest'
import { codeBlockTerminalScript } from './code-block-terminal-script'

describe('codeBlockTerminalScript', () => {
  it('runs a shell block in its own shell, keeping tabs and without its trailing newline', () => {
    expect(codeBlockTerminalScript('glab auth status\n', 'shell')).toEqual({
      script: 'glab auth status',
      shell: 'bash'
    })
    expect(codeBlockTerminalScript('cd repo\r\nmake\rls', 'zsh')).toEqual({
      script: 'cd repo\nmake\nls',
      shell: 'zsh'
    })
    expect(codeBlockTerminalScript("printf 'a\\tb' > x\tq", 'sh')?.script).toBe(
      "printf 'a\\tb' > x\tq"
    )
  })

  it('offers nothing for hidden characters, padding, or other languages', () => {
    expect(codeBlockTerminalScript('ls\x03 -la', 'sh')).toBeNull()
    expect(codeBlockTerminalScript('rm‮ -rf x', 'sh')).toBeNull()
    expect(codeBlockTerminalScript('lsㅤ -la', 'sh')).toBeNull()
    expect(codeBlockTerminalScript(`ls${' '.repeat(40)}; rm -rf x`, 'sh')).toBeNull()
    expect(codeBlockTerminalScript(`ls${' '.repeat(40)}; rm -rf x`, 'sh')).toBeNull()
    expect(codeBlockTerminalScript('print(1)', 'python')).toBeNull()
    expect(codeBlockTerminalScript('ls', undefined)).toBeNull()
    expect(codeBlockTerminalScript(' \n', 'bash')).toBeNull()
  })
})
