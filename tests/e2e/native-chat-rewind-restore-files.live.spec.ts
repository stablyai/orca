// Live: a real Claude Code agent (cheap gateway model) edits a real git worktree through a headless
// serve host. Rewind to the second message with "Also restore files" puts the files back to how
// they were when it was sent, Undo brings the agent's edits back, and the user's HEAD, index and
// stash list are never touched by the per-turn snapshots.
// Needs a model: ORCA_E2E_AI_GATEWAY_KEY_FILE names a Vercel AI Gateway key (Anthropic-compatible).
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../src/shared/agent-session/structured-agent-session-create'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../src/shared/agent-session/lifecycle/structured-agent-session-mutation'
import { structuredAgentSessionMessageSendMutation } from '../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionHistoryResult } from '../../src/shared/agent-session/agent-session-wire'
import type {
  AgentSessionCheckpointPreview,
  AgentSessionCheckpointRestoreResult
} from '../../src/shared/agent-session/lifecycle/agent-session-checkpoint'

const KEY_FILE = process.env.ORCA_E2E_AI_GATEWAY_KEY_FILE
const MODEL = process.env.ORCA_E2E_AI_GATEWAY_MODEL ?? 'moonshotai/kimi-k2'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Every non-.git file under `root` with its content: what the user would see on disk. */
function files(root: string, dir = root, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === '.claude') {
      continue
    }
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      files(root, full, out)
    } else {
      out[path.relative(root, full)] = readFileSync(full, 'utf8')
    }
  }
  return out
}

const text = (value: string) => ({
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: value }]
})

test.describe('rewind with file restore, live agent', () => {
  test.skip(!KEY_FILE, 'needs a real model: set ORCA_E2E_AI_GATEWAY_KEY_FILE')

  test('restores the files a real agent changed, then undoes the restore', async () => {
    // A real model runs two tool-using turns, a rewind and two restores: minutes, not seconds.
    test.setTimeout(900_000)
    const worktree = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-rewind-files-'))
    git(worktree, 'init', '-q')
    git(worktree, 'config', 'user.name', 'E2E')
    git(worktree, 'config', 'user.email', 'e2e@example.test')
    writeFileSync(path.join(worktree, '.gitignore'), 'build/\n')
    writeFileSync(path.join(worktree, 'app.txt'), 'v0\n')
    git(worktree, 'add', '.')
    git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
    writeFileSync(path.join(worktree, 'staged.txt'), 'staged by the user\n')
    git(worktree, 'add', 'staged.txt')
    const head = git(worktree, 'rev-parse', 'HEAD')
    const key = readFileSync(KEY_FILE!, 'utf8').trim()
    const host = await launchHeadlessPairedRuntimeHost({
      extraEnv: {
        ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh',
        ANTHROPIC_AUTH_TOKEN: key,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL
      }
    })
    const call = async <T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> =>
      (await host.client.call<T>(method, params, { timeoutMs })).result
    try {
      const added = await call<{ repo: { id: string } }>('repo.add', {
        path: worktree
      })
      let worktreeId = ''
      await expect
        .poll(async () => {
          const listed = await call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${added.repo.id}`
          })
          return (worktreeId = listed.worktrees[0]?.id ?? '')
        })
        .not.toBe('')
      const sessionId = createStructuredAgentSessionId('claude', randomUUID)
      await call(
        'agentSession.create',
        structuredAgentSessionCreateParams({
          sessionId,
          worktree: `id:${worktreeId}`,
          agent: 'claude',
          options: { permissionMode: 'full-access' },
          randomUuid: randomUUID
        })
      )
      const tail = () =>
        call<AgentSessionHistoryResult>('agentSession.history', {
          sessionId,
          direction: 'tail',
          limit: 200
        })
      let fence = 0
      await expect
        .poll(async () => (fence = (await tail()).page.fence ?? 0), {
          timeout: 120_000
        })
        .toBeGreaterThan(0)
      const send = async (prompt: string): Promise<string> => {
        const clientOperationId = createStructuredAgentSessionOperationId(randomUUID)
        const page = (await tail()).page
        await call(
          'agentSession.send',
          {
            ...structuredAgentSessionMessageSendMutation({
              sessionId,
              clientOperationId,
              expectedRuntimeFence: page.fence ?? fence,
              body: text(prompt),
              delivery: 'queue-if-active'
            })
          },
          120_000
        )
        return clientOperationId
      }
      /** The turn the message opened has an agent reply after it and the chat has gone quiet
       *  (no new rows across several polls): models don't always end with the word asked for. */
      let lastSequence = -1
      let quietPolls = 0
      const settled = async (clientOperationId: string): Promise<boolean> => {
        const page = (await tail()).page
        const index = page.items.findIndex(
          (item) => item.itemId === agentJournalSubmissionKey(clientOperationId)
        )
        const replied =
          index !== -1 &&
          page.items
            .slice(index + 1)
            .some((item) => item.body.kind === 'message' && item.body.role === 'assistant')
        const newest = page.items.at(-1)?.sequence ?? -1
        quietPolls = newest === lastSequence ? quietPolls + 1 : 0
        lastSequence = newest
        if (!replied) {
          const submission = page.submissions.find(
            (entry) => entry.clientMessageId === clientOperationId
          )
          console.log(
            `[rewind-files live] waiting: dispatch=${submission?.dispatchState} refs=${git(worktree, 'for-each-ref', '--format=%(refname)', 'refs/orca/').split('\n').length} last=${JSON.stringify(page.items.at(-1)?.body).slice(0, 120)}`
          )
        }
        return replied && quietPolls >= 4
      }

      const first = await send(
        'Using your file tools, create a file named feature.txt containing exactly the line: one. Do nothing else, then reply DONE.'
      )
      await expect.poll(() => settled(first), { timeout: 300_000, intervals: [3000] }).toBe(true)
      const beforeSecond = files(worktree)
      expect(beforeSecond['feature.txt']?.trim()).toBe('one')

      const second = await send(
        'Using your file tools: overwrite app.txt so it contains exactly the line: v2. Delete feature.txt. Create notes/todo.txt containing exactly the line: later. Do nothing else, then reply DONE.'
      )
      await expect.poll(() => settled(second), { timeout: 300_000, intervals: [3000] }).toBe(true)
      const afterSecond = files(worktree)
      expect(afterSecond).not.toEqual(beforeSecond)
      // Snapshots never touch the user's HEAD, staging or stash list.
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('staged.txt')
      expect(git(worktree, 'stash', 'list')).toBe('')
      const refs = git(worktree, 'for-each-ref', '--format=%(refname)', 'refs/orca/checkpoints/')
      expect(
        refs.split('\n').filter((ref) => ref.includes('/turn/')).length
      ).toBeGreaterThanOrEqual(2)

      // Rewind the chat to the second message (as the UI does), then restore its files.
      const itemId = agentJournalSubmissionKey(second)
      const preview = await call<AgentSessionCheckpointPreview>('agentSession.checkpointPreview', {
        sessionId,
        itemId
      })
      expect(preview).toMatchObject({ available: true, headMoved: false })
      await expect
        .poll(
          async () => {
            const page = (await tail()).page
            const fields = { itemId, expectedEpoch: page.epoch }
            const response = await host.client.call<unknown>(
              'agentSession.rewind',
              {
                ...fields,
                envelope: {
                  sessionId,
                  clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
                  expectedRuntimeFence: page.fence ?? fence,
                  payloadFingerprint: structuredAgentSessionPayloadFingerprint({
                    method: 'agentSession.rewind',
                    sessionId,
                    fields
                  })
                }
              },
              { timeoutMs: 200_000 }
            )
            return JSON.stringify(response.result)
          },
          { timeout: 240_000, intervals: [5000] }
        )
        .toContain('"ok":true')
      // The turn's tail (naming, final events) may still count as working for a moment.
      const box: { restored?: AgentSessionCheckpointRestoreResult } = {}
      await expect
        .poll(
          async () => {
            try {
              box.restored = await call<AgentSessionCheckpointRestoreResult>(
                'agentSession.checkpointRestore',
                { sessionId, itemId },
                120_000
              )
              return 'restored'
            } catch (error) {
              if (String(error).includes('agent_session_checkpoint_busy')) {
                return 'busy'
              }
              throw error
            }
          },
          { timeout: 60_000, intervals: [2000] }
        )
        .toBe('restored')
      const restored = box.restored!
      expect(restored.changedFiles).toBe(
        (preview.available && preview.changedFiles) || restored.changedFiles
      )
      expect(files(worktree)).toEqual(beforeSecond)
      expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('staged.txt')
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)

      await call('agentSession.checkpointUndo', { sessionId, undoId: restored.undoId }, 120_000)
      expect(files(worktree)).toEqual(afterSecond)
      console.log(
        `[rewind-files live] model=${MODEL} restored=${restored.changedFiles} files; before=${JSON.stringify(beforeSecond)} after=${JSON.stringify(afterSecond)}`
      )
    } finally {
      await host.dispose()
      rmSync(worktree, { recursive: true, force: true })
    }
  })
})
