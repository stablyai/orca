import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { buildAgentTerminalResumePlan } from '../../../shared/agent-terminal-resume-plan'
import {
  buildAiVaultResumeStartupForWorktree,
  type AiVaultResumeWorktreeArgs
} from './ai-vault-resume-command'
import {
  AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES,
  AI_VAULT_SESSION_DRAG_TYPE,
  clearAiVaultSessionDragData,
  hasAiVaultSessionDragData,
  readAiVaultSessionDragData,
  writeAiVaultSessionDragData,
  type AiVaultSessionDragPayload
} from './ai-vault-session-drag'

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

class FakeDataTransfer {
  effectAllowed = 'all'
  types: string[] = []
  private readonly data = new Map<string, string>()

  setData(type: string, value: string): void {
    if (!this.types.includes(type)) {
      this.types.push(type)
    }
    this.data.set(type, value)
  }

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

class TypeOnlyDataTransfer extends FakeDataTransfer {
  override getData(_type: string): string {
    return ''
  }
}

function createTransfer(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer
}

function historyState(unrelatedEnv: Record<string, string>): AiVaultResumeWorktreeArgs['state'] {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [],
    worktreesByRepo: {},
    settings: createGlobalSettingsFixture({
      agentCmdOverrides: { claude: 'selected-claude', codex: 'unused-codex' },
      agentDefaultArgs: { claude: '--model first', codex: '--model unused' },
      agentDefaultEnv: { claude: { SELECTED: 'first' }, codex: unrelatedEnv },
      agentPermissionDefault: 'ask',
      agentPermissionOverrides: { claude: 'full-access', codex: 'own' }
    })
  }
}

function historyDrag(state: AiVaultResumeWorktreeArgs['state'], sessionId = 'session-1') {
  const session = { agent: 'claude' as const, sessionId, cwd: '/repo', codexHome: null }
  const startup = buildAiVaultResumeStartupForWorktree({ state, session })
  const realHomeStartup = buildAiVaultResumeStartupForWorktree({
    state,
    session: { ...session, codexHome: null }
  })
  const transfer = createTransfer()
  writeAiVaultSessionDragData(transfer, {
    agent: session.agent,
    sessionId,
    title: 'Claude session',
    ...startup,
    sessionFilePath: '/sessions/claude.jsonl',
    sessionExecutionHostId: 'local',
    codexHome: session.codexHome,
    sessionCwd: session.cwd,
    realHomeStartup
  })
  const serialized = transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
  const payload = readAiVaultSessionDragData(transfer)
  expect(payload).not.toBeNull()
  return { serialized, payload }
}

function serializedLeaves(value: unknown): number {
  return value !== null && typeof value === 'object'
    ? Object.values(value).reduce<number>((sum, child) => sum + serializedLeaves(child), 0)
    : 1
}

function effectiveDragResume(payload: AiVaultSessionDragPayload | null) {
  if (!payload?.resume) {
    throw new Error('Expected typed History drag')
  }
  const plan = buildAgentTerminalResumePlan({
    agent: 'claude',
    providerSession: { key: 'session_id', id: payload.sessionId },
    resume: payload.resume,
    settings: { agentDefaultArgs: { claude: '--model host' } },
    runtime: { platform: 'linux', pty: { terminalWindowsWslDistro: null } },
    isRemote: false
  })
  if (!plan) {
    throw new Error('Expected a buildable selected recipe')
  }
  return plan
}

describe('Session History session drag data', () => {
  afterEach(() => {
    clearAiVaultSessionDragData()
  })

  it('bounds actual startup clones and drag serialization at a fixed viewport for unrelated env N/10N', () => {
    const samples = [100, 1000].map((size) => {
      const state = historyState(
        Object.fromEntries(
          Array.from({ length: size }, (_, index) => [`UNUSED_${index}`, 'unrelated-value'])
        )
      )
      const clone = vi.spyOn(globalThis, 'structuredClone')
      try {
        const drags = Array.from({ length: 8 }, (_, index) =>
          historyDrag(state, `session-${index}`)
        )
        expect(clone).toHaveBeenCalledTimes(16)
        const cloneInputs = clone.mock.calls.map(([input]) => JSON.stringify(input) ?? '')
        for (const serialized of [...cloneInputs, ...drags.map((drag) => drag.serialized)]) {
          expect(serialized).not.toContain('UNUSED_')
          expect(serialized).not.toContain('"codex":')
        }
        const count = (serialized: string) => serializedLeaves(JSON.parse(serialized))
        return {
          cloneLeaves: cloneInputs.map(count),
          cloneBytes: cloneInputs.map((text) => new TextEncoder().encode(text).byteLength),
          dragLeaves: drags.map(({ serialized }) => count(serialized)),
          dragBytes: drags.map(({ serialized }) => new TextEncoder().encode(serialized).byteLength)
        }
      } finally {
        clone.mockRestore()
      }
    })
    expect(samples[1]).toEqual(samples[0])
    for (const bytes of samples[1]!.dragBytes) {
      expect(bytes).toBeGreaterThan(0)
      expect(bytes).toBeLessThan(AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES)
    }
  })

  it('keeps the 9000-character unrelated env drag valid and selected changes effective', () => {
    const state = historyState({ UNUSED: 'x'.repeat(9000) })
    const first = historyDrag(state)
    expect(new TextEncoder().encode(first.serialized).byteLength).toBeLessThan(
      AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES
    )
    expect(first.payload?.resume?.recipe).toMatchObject({
      source: 'current-inputs',
      settings: {
        agentCmdOverrides: { claude: 'selected-claude' },
        agentDefaultArgs: { claude: '--model first' },
        agentDefaultEnv: { claude: { SELECTED: 'first' } },
        agentPermissionDefault: 'ask',
        agentPermissionOverrides: { claude: 'full-access' }
      }
    })
    if (!state.settings) {
      throw new Error('Missing fixture settings')
    }
    state.settings.agentCmdOverrides = { claude: 'changed-claude' }
    state.settings.agentDefaultArgs = { claude: '--model second' }
    state.settings.agentDefaultEnv!.claude = { SELECTED: 'second' }
    state.settings.agentPermissionOverrides = { claude: 'accept-edits' }
    const second = historyDrag(state)
    const originalPlan = effectiveDragResume(first.payload)
    const changedPlan = effectiveDragResume(second.payload)
    expect(originalPlan.launchCommand).toContain('selected-claude')
    expect(originalPlan.launchCommand).toContain('first')
    expect(originalPlan.launchCommand).toContain('--dangerously-skip-permissions')
    expect(originalPlan.env).toEqual({ SELECTED: 'first' })
    expect(changedPlan.launchCommand).toContain('changed-claude')
    expect(changedPlan.launchCommand).toContain('second')
    expect(changedPlan.launchCommand).toContain('acceptEdits')
    expect(changedPlan.launchCommand).not.toContain('--dangerously-skip-permissions')
    expect(changedPlan.env).toEqual({ SELECTED: 'second' })
    state.settings.agentPermissionOverrides = {}
    const inherited = effectiveDragResume(historyDrag(state).payload)
    expect(inherited.launchCommand).toContain('default')
    expect(inherited.launchCommand).not.toContain('acceptEdits')
  })

  it('writes and reads the private session history payload', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'claude',
      sessionId: 'session-1',
      title: 'Fix terminal split',
      command: "cd '/repo' && claude --resume session-1",
      sessionFilePath: '/Users/ada/.claude/projects/-repo/session-1.jsonl',
      codexHome: '/Users/ada/Library/Application Support/orca/codex-runtime-home/home',
      sessionCwd: '/repo',
      env: { ANTHROPIC_BASE_URL: 'https://claude.example.test' },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      launchConfig: {
        agentCommand: 'claude --dangerously-skip-permissions',
        agentArgs: '--dangerously-skip-permissions',
        agentEnv: { ANTHROPIC_BASE_URL: 'https://claude.example.test' }
      },
      realHomeStartup: {
        command: "cd '/repo' && claude --resume session-1",
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME']
      }
    }

    writeAiVaultSessionDragData(transfer, payload)

    expect(transfer.effectAllowed).toBe('copy')
    expect(hasAiVaultSessionDragData(transfer)).toBe(true)
    expect(readAiVaultSessionDragData(transfer)).toEqual(payload)
  })

  it('round-trips selected resume inputs and the real-home alternative without executable text', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'typed-session',
      title: 'Typed resume',
      resume: {
        recipe: {
          source: 'current-inputs',
          settings: { agentDefaultArgs: { codex: '--model selected' } }
        },
        codexHome: '/managed'
      },
      realHomeStartup: {
        resume: { recipe: { source: 'saved' }, codexHome: null },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME']
      }
    }
    writeAiVaultSessionDragData(transfer, payload)
    expect(readAiVaultSessionDragData(transfer)).toEqual(payload)
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        ...payload,
        command: 'also executable'
      })
    )
    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('preserves an explicit null sessionCwd across the serialized round-trip', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'session-3',
      title: 'Session without a recorded cwd',
      command: 'codex resume session-3',
      sessionFilePath: '/tmp/orca/codex-accounts/a/home/sessions/2026/07/20/rollout-x.jsonl',
      codexHome: '/tmp/orca/codex-accounts/a/home',
      sessionCwd: null
    }

    writeAiVaultSessionDragData(transfer, payload)

    const read = readAiVaultSessionDragData(transfer)
    expect(read).toEqual(payload)
    // Explicit null (no cwd) must stay distinguishable from an absent key (old serializer).
    expect(read && 'sessionCwd' in read).toBe(true)
  })

  it('round-trips a structured session without a legacy resume command', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'session-structured',
      structuredSession: { sessionId: 'session-structured', workspaceId: 'worktree-1' },
      title: 'Native chat',
      command: ''
    }

    writeAiVaultSessionDragData(transfer, payload)

    expect(readAiVaultSessionDragData(transfer)).toEqual(payload)
  })

  it('still rejects a blank resume command for an ordinary CLI session', () => {
    const transfer = createTransfer()
    writeAiVaultSessionDragData(transfer, {
      agent: 'codex',
      sessionId: 'session-cli',
      title: 'CLI session',
      command: ''
    })

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('keeps sessionCwd absent when an older serializer omitted it', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        agent: 'codex',
        sessionId: 'session-4',
        title: 'Old-window payload',
        command: 'codex resume session-4'
      })
    )

    const read = readAiVaultSessionDragData(transfer)
    expect(read).not.toBeNull()
    expect(read && 'sessionCwd' in read).toBe(false)
  })

  it('rejects blank session file paths', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        agent: 'claude',
        sessionId: 'session-1',
        title: 'Blank session file path',
        command: 'claude --resume session-1',
        sessionFilePath: '   '
      })
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('rejects malformed payloads', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({ kind: 'ai-vault-session', version: 1, agent: 'bad', command: 'claude' })
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('rejects array-shaped env records', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        agent: 'claude',
        sessionId: 'session-1',
        title: 'Malformed env',
        command: 'claude --resume session-1',
        env: ['ANTHROPIC_BASE_URL=https://claude.example.test']
      })
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('rejects malformed env deletion lists', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        agent: 'codex',
        sessionId: 'session-1',
        title: 'Malformed env deletion',
        command: 'codex resume session-1',
        envToDelete: ['CODEX_HOME', '']
      })
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('rejects array-shaped launch config env records', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        agent: 'claude',
        sessionId: 'session-1',
        title: 'Malformed launch config env',
        command: 'claude --resume session-1',
        launchConfig: {
          agentArgs: '',
          agentEnv: ['ANTHROPIC_BASE_URL=https://claude.example.test']
        }
      })
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('rejects oversized serialized payloads before parsing', () => {
    const transfer = createTransfer()
    const secret = 'ai-vault-drag-secret'
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      secret + 'x'.repeat(AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES)
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('rejects multibyte oversized payloads before parsing', () => {
    const transfer = createTransfer()
    transfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '😀'.repeat(4097))

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('does not retain an oversized internal payload for the hidden-data fallback', () => {
    const source = createTransfer()
    writeAiVaultSessionDragData(source, {
      agent: 'claude',
      sessionId: 'session-oversized',
      title: 'Oversized payload',
      command: 'x'.repeat(AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES)
    })

    const dropTransfer = new TypeOnlyDataTransfer() as unknown as DataTransfer
    dropTransfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '')

    expect(readAiVaultSessionDragData(dropTransfer)).toBeNull()
  })

  it('falls back to the active renderer drag payload when Chromium hides custom data', () => {
    const source = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'session-2',
      title: 'Resume a hidden payload',
      command: "cd '/repo' && codex resume session-2"
    }
    writeAiVaultSessionDragData(source, payload)

    const dropTransfer = new TypeOnlyDataTransfer() as unknown as DataTransfer
    dropTransfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '')

    expect(hasAiVaultSessionDragData(dropTransfer)).toBe(true)
    expect(readAiVaultSessionDragData(dropTransfer)).toEqual(payload)

    clearAiVaultSessionDragData()
    expect(readAiVaultSessionDragData(dropTransfer)).toBeNull()
  })
})
