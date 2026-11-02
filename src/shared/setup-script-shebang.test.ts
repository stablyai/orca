import { describe, it, expect } from 'vitest'
import { parseSetupScriptShebang, stripLeadingShebangLine } from './setup-script-shebang'

describe('parseSetupScriptShebang', () => {
  it('keeps the interpreter flags a script declares', () => {
    // Launching bash path ignores shebang flags unless replayed with set; otherwise pipefail is lost.
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
    // Invocation-only flags make set exit 2; runner set -e would abort before setup starts.
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
