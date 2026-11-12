import { describe, expect, it } from 'vitest'
import { selectUniqueRootAgentCommand } from '../../agent-status/process/posix-pane-agent-command-line'
import { resolveResumeLaunchRecipe } from './resume-launch-recipe'
import { agentCommandLineBypassesPermissions } from '../permissions/agent-command-line-permissions'
import { buildAgentResumeStartupPlan } from '../startup/tui-agent-resume-startup'
import { tokenizeStartupCommand } from '../startup/tui-agent-startup-shell'

describe('unrecorded agent resume permissions', () => {
  it('restores full-access flags and env for non-Claude sessions observed in bypass mode', () => {
    const bypassSession = {
      key: 'conversation_id' as const,
      id: 'conv-1',
      permissionMode: 'bypassPermissions'
    }
    expect(resolveResumeLaunchRecipe(undefined, 'antigravity', bypassSession)).toEqual({
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    })
    expect(resolveResumeLaunchRecipe(undefined, 'gemini', bypassSession)).toEqual({
      agentArgs: '--yolo',
      agentEnv: {}
    })
    expect(resolveResumeLaunchRecipe(undefined, 'zcode', bypassSession)).toEqual({
      agentArgs: '--mode yolo',
      agentEnv: {}
    })
    expect(resolveResumeLaunchRecipe(undefined, 'goose', bypassSession)).toEqual({
      agentArgs: '',
      agentEnv: { GOOSE_MODE: 'auto' }
    })

    const agyRecipe = resolveResumeLaunchRecipe(undefined, 'antigravity', bypassSession)
    const agyPlan = buildAgentResumeStartupPlan({
      agent: 'antigravity',
      providerSession: bypassSession,
      cmdOverrides: {},
      agentArgs: agyRecipe.agentArgs,
      platform: 'win32',
      shell: 'powershell'
    })
    const agyTokens = tokenizeStartupCommand(agyPlan?.launchCommand ?? '', 'powershell')
    expect(agyTokens.ok && agyTokens.tokens).toEqual([
      'agy',
      '--dangerously-skip-permissions',
      '--conversation',
      'conv-1'
    ])

    // Bare unrecorded sessions must not invent bypass flags on resume.
    const bareSession = { key: 'conversation_id' as const, id: 'conv-1' }
    const bareRecipe = resolveResumeLaunchRecipe(undefined, 'antigravity', bareSession)
    const barePlan = buildAgentResumeStartupPlan({
      agent: 'antigravity',
      providerSession: bareSession,
      cmdOverrides: {},
      agentArgs: bareRecipe.agentArgs,
      platform: 'win32',
      shell: 'powershell'
    })
    const bareTokens = tokenizeStartupCommand(barePlan?.launchCommand ?? '', 'powershell')
    expect(bareTokens.ok && bareTokens.tokens).toEqual(['agy', '--conversation', 'conv-1'])

    // Codex resumes keep their saved rollout permissions unless forking (#10886).
    const codexSession = {
      key: 'session_id' as const,
      id: 'thread-1',
      permissionMode: 'bypassPermissions'
    }
    const codexRecipe = resolveResumeLaunchRecipe(undefined, 'codex', codexSession)
    const codexResume = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: codexSession,
      cmdOverrides: {},
      agentArgs: codexRecipe.agentArgs,
      platform: 'linux',
      shell: 'posix'
    })
    const codexTokens = tokenizeStartupCommand(codexResume?.launchCommand ?? '', 'posix')
    expect(codexTokens.ok && codexTokens.tokens).toEqual([
      'codex',
      '-c',
      'disable_paste_burst=true',
      'resume',
      'thread-1'
    ])
  })

  it.each([
    [
      'antigravity',
      '"C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\agy.exe" --dangerously-skip-permissions',
      true
    ],
    [
      'antigravity',
      'C:\\Program Files\\nodejs\\node.exe "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@google\\antigravity-cli\\bin\\agy.js" --dangerously-skip-permissions --conversation conv-1',
      true
    ],
    ['antigravity', '"C:\\Users\\me\\agy.exe" --conversation conv-1', false],
    ['antigravity', 'agy -- --dangerously-skip-permissions', false],
    ['gemini', 'gemini -y', true],
    ['gemini', 'gemini --approval-mode=yolo', true],
    ['gemini', 'gemini --approval-mode default', false],
    ['zcode', 'zcode --mode=yolo', true],
    ['droid', 'droid --auto=high', true],
    ['droid', 'droid --auto low', false],
    ['kimi', 'kimi --auto', true],
    ['kimi', 'kimi --yolo', false],
    ['grok', 'grok --permission-mode bypassPermissions --permission-mode default', false],
    ['devin', 'devin --permission-mode=bypass --respect-workspace-trust=false', true],
    ['devin', 'devin --permission-mode=bypass', false],
    ['continue', 'cn --allow "*"', true]
  ] as const)('detects OS process bypass argv for %s: %s -> %s', (agent, commandLine, expected) => {
    expect(agentCommandLineBypassesPermissions(agent, commandLine)).toBe(expected)
  })

  it('selects the shallowest root agent command line and fails closed on sibling roots', () => {
    const lineage = [
      { pid: 100, ppid: 1, command: 'pwsh.exe' },
      { pid: 200, ppid: 100, command: 'agy --dangerously-skip-permissions' },
      { pid: 201, ppid: 200, command: 'node helper.js' },
      { pid: 202, ppid: 201, command: 'agy --subagent' }
    ]
    const matching = [lineage[1], lineage[3]]
    expect(selectUniqueRootAgentCommand(matching, lineage)).toBe(
      'agy --dangerously-skip-permissions'
    )

    const siblingRoots = [
      { pid: 100, ppid: 1, command: 'pwsh.exe' },
      { pid: 200, ppid: 100, command: 'agy --dangerously-skip-permissions' },
      { pid: 300, ppid: 100, command: 'agy' }
    ]
    expect(
      selectUniqueRootAgentCommand([siblingRoots[1], siblingRoots[2]], siblingRoots)
    ).toBeNull()
  })
})
