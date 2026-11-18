import { describe, expect, it } from 'vitest'
import {
  getExtraAgentArgsPlaceholder,
  mergeExtraAgentArgs,
  parseExtraAgentArgs
} from './automation-extra-agent-args'

describe('antigravity extra agent args', () => {
  it('accepts remote-agent, remote-control, new-project, project, agent, add-dir, model, and effort', () => {
    const parsed = parseExtraAgentArgs({
      agent: 'antigravity',
      extraAgentArgs:
        '--model gemini-3-pro --effort xhigh --remote-agent --remote-control --new-project --project proj-1 --agent reviewer --add-dir docs --add-dir tests'
    })
    expect(parsed).toEqual({
      ok: true,
      tokens: [
        '--model',
        'gemini-3-pro',
        '--effort',
        'xhigh',
        '--remote-agent',
        '--remote-control',
        '--new-project',
        '--project',
        'proj-1',
        '--agent',
        'reviewer',
        '--add-dir',
        'docs',
        '--add-dir',
        'tests'
      ],
      kinds: expect.any(Set)
    })

    const merged = mergeExtraAgentArgs({
      agent: 'antigravity',
      defaultArgs: '--model old-model --effort low --remote-agent --project default-proj',
      extraAgentArgs: '--model new-model --remote-control',
      shell: 'posix'
    })
    expect(merged).toEqual({
      ok: true,
      agentArgs:
        "'--effort' 'low' '--remote-agent' '--project' 'default-proj' '--model' 'new-model' '--remote-control'"
    })

    const overridden = mergeExtraAgentArgs({
      agent: 'antigravity',
      defaultArgs: '--remote-agent --project old-proj --effort low',
      extraAgentArgs: '--remote-agent --project new-proj',
      shell: 'posix'
    })
    expect(overridden).toEqual({
      ok: true,
      agentArgs: "'--effort' 'low' '--remote-agent' '--project' 'new-proj'"
    })
  })

  it('rejects values on bare flags, repeated single options, and disallowed flags', () => {
    expect(
      parseExtraAgentArgs({
        agent: 'antigravity',
        extraAgentArgs: '--remote-agent=true'
      })
    ).toMatchObject({ ok: false, errorCode: 'invalid' })

    expect(
      parseExtraAgentArgs({
        agent: 'antigravity',
        extraAgentArgs: '--remote-agent --remote-agent'
      })
    ).toMatchObject({ ok: false, errorCode: 'invalid' })

    expect(
      parseExtraAgentArgs({
        agent: 'antigravity',
        extraAgentArgs: '--project a --project b'
      })
    ).toMatchObject({ ok: false, errorCode: 'invalid' })

    expect(
      parseExtraAgentArgs({
        agent: 'antigravity',
        extraAgentArgs: '--dangerously-skip-permissions'
      })
    ).toMatchObject({ ok: false, errorCode: 'optionNotAllowed' })
  })

  it('accepts dash-leading project operands in extra agent args', () => {
    expect(
      parseExtraAgentArgs({
        agent: 'antigravity',
        extraAgentArgs: '--remote-agent --project -my-proj'
      })
    ).toMatchObject({
      ok: true,
      tokens: ['--remote-agent', '--project', '-my-proj']
    })

    expect(
      mergeExtraAgentArgs({
        agent: 'antigravity',
        defaultArgs: '--project -old-proj --effort high',
        extraAgentArgs: '--remote-agent --project -my-proj',
        shell: 'posix'
      })
    ).toEqual({
      ok: true,
      agentArgs: "'--effort' 'high' '--remote-agent' '--project' '-my-proj'"
    })
  })

  it('formats bare flag placeholders without a trailing placeholder value', () => {
    const placeholder = getExtraAgentArgsPlaceholder('antigravity')
    expect(placeholder).toContain('--remote-agent')
    expect(placeholder).not.toMatch(/--remote-agent\s+(?:docs|high|model-id)/)
  })
})
