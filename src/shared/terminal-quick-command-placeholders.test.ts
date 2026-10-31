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

  it.each([
    '/repo/$(touch pwned).py',
    '/repo/`touch pwned`.py',
    '/repo/a";touch pwned;".py',
    '/repo/a\nb.py',
    '/repo/run!9999.py',
    '/repo/%USERNAME%/a.py',
    '/repo/a\u201D; Start-Process calc; Write-Output \u201C.py',
    '/repo/a\u201E.py',
    '/repo/trail\\'
  ])('refuses a path a shell could execute: %j', (filePath) => {
    expect(
      substituteTerminalQuickCommandPlaceholders('python "${file}"', {
        filePath,
        relativePath: 'a.py',
        workspaceFolder: '/repo'
      })
    ).toEqual({ status: 'unsafe-path' })
  })

  it('keeps a drive root, the one value that ends in a backslash', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('cd "${fileDirname}"', {
        filePath: 'C:\\script.py',
        relativePath: 'script.py',
        workspaceFolder: 'C:\\'
      })
    ).toEqual({ status: 'ok', command: 'cd "C:\\"' })
  })

  it('refuses a ${workspaceFolder} ending in a backslash', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('echo "${workspaceFolder}"', {
        filePath: null,
        relativePath: null,
        workspaceFolder: '/repo/trail\\'
      })
    ).toEqual({ status: 'unsafe-path' })
  })

  it('refuses an unsafe ${workspaceFolder}', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('cd "${workspaceFolder}"', {
        filePath: null,
        relativePath: null,
        workspaceFolder: '/repo/$(id)'
      })
    ).toEqual({ status: 'unsafe-path' })
  })

  it.each([
    ["python '${file}'", "/repo/a'; id; echo '.py"],
    ['python ${file}', "/repo/a'; id; echo '.py"],
    ['python ${file}', '/repo/a;id;.py'],
    ['python ${file}', '/repo/a&id&.py'],
    ['python ${file}', '/repo/a|id.py'],
    ['python ${file}', '/repo/(id).py'],
    ['bash -c \'python "${file}"\'', "/repo/a'; id; echo '.py"],
    ['echo "$(cat ${file})"', '/repo/a;id;.py'],
    ['python \\"${file}', '/repo/a;id;.py'],
    ["python '${file}'", '/repo/a\u2019; id; echo \u2018.py'],
    ['python \u201C"${file}', '/repo/a;id;.py']
  ])('refuses %j when the path can leave its quoting: %j', (command, filePath) => {
    expect(
      substituteTerminalQuickCommandPlaceholders(command, {
        filePath,
        relativePath: 'a.py',
        workspaceFolder: '/repo'
      })
    ).toEqual({ status: 'unsafe-path' })
  })

  it('keeps a lone percent sign, which no shell expands', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('python "${file}"', {
        filePath: '/repo/100%.py',
        relativePath: '100%.py',
        workspaceFolder: '/repo'
      })
    ).toEqual({ status: 'ok', command: 'python "/repo/100%.py"' })
  })

  it('keeps paths with shell punctuation inside plain double quotes', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('python "${file}"', {
        filePath: '/repo/app/(group)/R&D;notes.py',
        relativePath: 'app/(group)/R&D;notes.py',
        workspaceFolder: '/repo'
      })
    ).toEqual({ status: 'ok', command: 'python "/repo/app/(group)/R&D;notes.py"' })
  })

  it('keeps paths with spaces and apostrophes', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('python "${file}"', {
        filePath: "/repo/Matt's notes.py",
        relativePath: "Matt's notes.py",
        workspaceFolder: '/repo'
      })
    ).toEqual({ status: 'ok', command: 'python "/repo/Matt\'s notes.py"' })
  })

  it('keeps a typographic apostrophe inside plain double quotes', () => {
    expect(
      substituteTerminalQuickCommandPlaceholders('python "${file}"', {
        filePath: '/repo/Matt\u2019s notes.py',
        relativePath: 'Matt\u2019s notes.py',
        workspaceFolder: '/repo'
      })
    ).toEqual({ status: 'ok', command: 'python "/repo/Matt\u2019s notes.py"' })
  })

  it('passes commands without placeholders through', () => {
    expect(substituteTerminalQuickCommandPlaceholders('git status', posixFile)).toEqual({
      status: 'ok',
      command: 'git status'
    })
  })
})
