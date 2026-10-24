import { describe, expect, it } from 'vitest'
import {
  fileBasename,
  fileDirname,
  substituteTerminalQuickCommandPlaceholders,
  terminalQuickCommandUsesPlaceholders
} from './terminal-quick-command-placeholders'

const posixFile = {
  filePath: '/repo/src/app.py',
  relativePath: 'src/app.py',
  workspaceFolder: '/repo'
}

const windowsFile = {
  filePath: 'C:\\Github\\Toolbox\\script.py',
  relativePath: 'script.py',
  workspaceFolder: 'C:\\Github\\Toolbox'
}

describe('terminalQuickCommandUsesPlaceholders', () => {
  it('detects known editor path tokens and ignores other dollar forms', () => {
    expect(terminalQuickCommandUsesPlaceholders('python "${file}"')).toBe(true)
    expect(terminalQuickCommandUsesPlaceholders('cd ${workspaceFolder}')).toBe(true)
    expect(terminalQuickCommandUsesPlaceholders('echo $file')).toBe(false)
    expect(terminalQuickCommandUsesPlaceholders('git status')).toBe(false)
  })
})

describe('fileBasename / fileDirname', () => {
  it('splits POSIX and Windows paths', () => {
    expect(fileBasename('/repo/src/app.py')).toBe('app.py')
    expect(fileDirname('/repo/src/app.py')).toBe('/repo/src')
    expect(fileBasename('C:\\Github\\Toolbox\\script.py')).toBe('script.py')
    expect(fileDirname('C:\\Github\\Toolbox\\script.py')).toBe('C:\\Github\\Toolbox')
    expect(fileDirname('/app.py')).toBe('/')
    expect(fileDirname('script.py')).toBe('.')
    expect(fileDirname('C:\\script.py')).toBe('C:\\')
    expect(fileDirname('C:/script.py')).toBe('C:/')
  })
})

describe('substituteTerminalQuickCommandPlaceholders', () => {
  it('replaces every known token from the active editor file', () => {
    const result = substituteTerminalQuickCommandPlaceholders(
      'cd ${fileDirname}; python "${file}"; echo ${relativeFile} ${fileBasename} ${workspaceFolder}',
      posixFile
    )
    expect(result).toEqual({
      status: 'ok',
      command: 'cd /repo/src; python "/repo/src/app.py"; echo src/app.py app.py /repo'
    })
  })

  it('keeps Windows separators from the stored paths', () => {
    const result = substituteTerminalQuickCommandPlaceholders(
      '.\\.venv\\Scripts\\python.exe "${file}"',
      windowsFile
    )
    expect(result).toEqual({
      status: 'ok',
      command: '.\\.venv\\Scripts\\python.exe "C:\\Github\\Toolbox\\script.py"'
    })
  })

  it('leaves unknown ${tokens} untouched', () => {
    const result = substituteTerminalQuickCommandPlaceholders('echo ${env:HOME} ${file}', posixFile)
    expect(result).toEqual({
      status: 'ok',
      command: 'echo ${env:HOME} /repo/src/app.py'
    })
  })

  it('refuses file tokens when no editor file is active', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('python "${file}"', {
        filePath: null,
        relativePath: null,
        workspaceFolder: '/repo'
      })
    ).toEqual({ status: 'missing-file' })
  })

  it('refuses ${workspaceFolder} when the workspace path is unknown', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('cd ${workspaceFolder}', {
        filePath: '/repo/src/app.py',
        relativePath: 'src/app.py',
        workspaceFolder: null
      })
    ).toEqual({ status: 'missing-workspace' })
  })

  it('passes commands without placeholders through', () => {
    expect(substituteTerminalQuickCommandPlaceholders('git status', posixFile)).toEqual({
      status: 'ok',
      command: 'git status'
    })
  })
})
