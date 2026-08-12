import { describe, it, expect } from 'vitest'
import {
  isShebangLine,
  parseSetupScriptShebang,
  scriptDeclaresPosixShell,
  stripLeadingShebangLine
} from './setup-script-shebang'

describe('scriptDeclaresPosixShell', () => {
  it('accepts the common env and absolute-path forms', () => {
    expect(scriptDeclaresPosixShell('#!/usr/bin/env bash\npnpm install')).toBe(true)
    expect(scriptDeclaresPosixShell('#!/bin/sh -e\npnpm install')).toBe(true)
    expect(scriptDeclaresPosixShell('#!/usr/bin/env -S bash -euo pipefail\npnpm install')).toBe(
      true
    )
    expect(scriptDeclaresPosixShell('#!/bin/zsh')).toBe(true)
  })

  it('rejects scripts with no interpreter line', () => {
    // Regression: batch-syntax setup scripts must stay on the cmd runner.
    expect(scriptDeclaresPosixShell('copy .env.example .env\nxcopy /E assets dist')).toBe(false)
    expect(scriptDeclaresPosixShell('')).toBe(false)
    expect(scriptDeclaresPosixShell('pnpm install\n#!/usr/bin/env bash')).toBe(false)
    expect(scriptDeclaresPosixShell('# !/usr/bin/env bash\npnpm install')).toBe(false)
  })

  it('rejects interpreters that are not POSIX shells', () => {
    expect(scriptDeclaresPosixShell('#!/usr/bin/env node\nconsole.log(1)')).toBe(false)
    expect(scriptDeclaresPosixShell('#!/usr/bin/env python3\nprint(1)')).toBe(false)
  })

  it('tolerates CRLF and Windows-style interpreter paths', () => {
    expect(scriptDeclaresPosixShell('#!/usr/bin/env bash\r\npnpm install')).toBe(true)
    expect(scriptDeclaresPosixShell('#!C:\\tools\\git\\bin\\bash.exe\r\npnpm install')).toBe(true)
  })
})

describe('parseSetupScriptShebang', () => {
  it('keeps the interpreter flags a script declares', () => {
    // Regression: the runner is launched as `bash <path>`, so flags survive only if they are
    // parsed out here and replayed with `set` — otherwise `pipefail` is silently lost.
    expect(parseSetupScriptShebang('#!/usr/bin/env -S bash -euo pipefail\nmake')).toEqual({
      interpreter: 'bash',
      shellOptions: ['-euo', 'pipefail']
    })
    expect(parseSetupScriptShebang('#!/bin/bash -e -x\nmake')).toEqual({
      interpreter: 'bash',
      shellOptions: ['-e', '-x']
    })
    expect(parseSetupScriptShebang('#!/bin/sh\nmake')).toEqual({
      interpreter: 'sh',
      shellOptions: []
    })
  })

  it('ignores interpreter arguments that `set` cannot apply', () => {
    // Regression: `set` rejects invocation-only flags with exit 2, and the runner's `set -e`
    // turns that into an aborted setup before its first line runs.
    expect(parseSetupScriptShebang('#!/bin/bash --norc\nmake')?.shellOptions).toEqual([])
    expect(parseSetupScriptShebang('#!/bin/bash -l\nmake')?.shellOptions).toEqual([])
    expect(parseSetupScriptShebang('#!/bin/bash -s\nmake')?.shellOptions).toEqual([])
    expect(parseSetupScriptShebang('#!/bin/bash -i\nmake')?.shellOptions).toEqual([])
    // Why: `-r` is accepted by `set` on some shells but silently restricts the rest of setup.
    expect(parseSetupScriptShebang('#!/bin/bash -r\nmake')?.shellOptions).toEqual([])
    expect(parseSetupScriptShebang('#!/bin/bash -ex -l\nmake')?.shellOptions).toEqual(['-ex'])
    // Why: a bare `-o` would print the whole shell-option table into the setup terminal.
    expect(parseSetupScriptShebang('#!/bin/bash -o\nmake')?.shellOptions).toEqual([])
    expect(parseSetupScriptShebang('#!/bin/bash -euo\nmake')?.shellOptions).toEqual([])
    expect(parseSetupScriptShebang('#!/bin/bash +o posix\nmake')?.shellOptions).toEqual([
      '+o',
      'posix'
    ])
  })

  it('returns null without an interpreter line', () => {
    expect(parseSetupScriptShebang('pnpm install')).toBeNull()
    expect(parseSetupScriptShebang('#!/usr/bin/env')).toBeNull()
  })
})

describe('stripLeadingShebangLine', () => {
  it('removes only a leading interpreter line', () => {
    expect(stripLeadingShebangLine('#!/usr/bin/env bash\npnpm install\n')).toBe('pnpm install\n')
    expect(stripLeadingShebangLine('#!/usr/bin/env bash\r\npnpm install')).toBe('pnpm install')
    expect(stripLeadingShebangLine('pnpm install\n#!/usr/bin/env bash')).toBe(
      'pnpm install\n#!/usr/bin/env bash'
    )
    expect(stripLeadingShebangLine('#!/usr/bin/env bash')).toBe('')
  })
})

describe('isShebangLine', () => {
  it('detects interpreter lines regardless of leading whitespace', () => {
    expect(isShebangLine('#!/usr/bin/env bash')).toBe(true)
    expect(isShebangLine('  #!/bin/sh')).toBe(true)
    expect(isShebangLine('#comment')).toBe(false)
    expect(isShebangLine('pnpm install')).toBe(false)
  })
})
