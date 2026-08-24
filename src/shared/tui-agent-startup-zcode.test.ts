import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'
import { buildAgentStartupPlan } from './tui-agent-startup'

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('ZCode startup plans', () => {
  it('uses the supported headless prompt entry point', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: 'fix the tests',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('zcode', null),
      platform: 'linux'
    })
    expect(plan?.launchCommand).toBe("zcode '--mode' 'yolo' --prompt 'fix the tests'")
  })

  it('respects manual permission settings instead of forcing yolo mode', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: 'fix the tests',
      cmdOverrides: {},
      agentArgs: '',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("zcode --prompt 'fix the tests'")
  })

  it('preserves multiline prompts as one shell argument', () => {
    const prompt = "Review this branch\nif (ready) { run it }\nDon't split this."
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt,
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('zcode', null),
      platform: 'linux'
    })

    expect(plan?.launchCommand).toContain(
      `--prompt 'Review this branch\nif (ready) { run it }\nDon'"'"'t split this.'`
    )
  })

  it('keeps the macOS Desktop fallback behind a prompt', () => {
    const prompted = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: 'review this branch',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('zcode', null),
      platform: 'darwin'
    })
    const empty = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: '',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('zcode', null),
      allowEmptyPromptLaunch: true,
      platform: 'darwin'
    })

    expect(prompted?.launchCommand).toContain("--prompt 'review this branch'")
    expect(prompted?.launchCommand).toContain('prompt_only=0')
    expect(empty?.launchCommand).not.toContain(" --prompt '")
  })

  it('allows an interactive PATH client without a prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-zcode-launch-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const zcode = join(bin, 'zcode')
    writeExecutable(
      zcode,
      'if [ "$1" = "--version" ]; then echo "zcode-app-cli 3.7.6-12"; else printf "args:%s\\n" "$*"; fi'
    )
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: '',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('zcode', null),
      allowEmptyPromptLaunch: true,
      platform: 'darwin'
    })

    const output = execFileSync('/bin/sh', ['-c', plan?.launchCommand ?? ''], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8'
    })
    expect(output).toContain('args:--mode yolo')
  })

  it('rejects an unprompted prompt-only PATH runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-zcode-launch-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeExecutable(
      join(bin, 'zcode'),
      'if [ "$1" = "--version" ]; then echo "zcode-runtime 0.16.3"; else exit 99; fi'
    )
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: '',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('zcode', null),
      allowEmptyPromptLaunch: true,
      platform: 'darwin'
    })

    const result = spawnSync('/bin/sh', ['-c', plan?.launchCommand ?? ''], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8'
    })
    expect(result.status).toBe(64)
    expect(result.stderr).toContain('prompted one-shot tasks only')
  })
})
