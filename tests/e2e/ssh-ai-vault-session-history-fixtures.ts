import { createHash } from 'node:crypto'
import {
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { dockerExec, dockerWriteFile } from './ssh-codex-repro-remote-fixtures'

export function seedRemoteAiVaultHistory(
  target: DockerSshRelayTarget,
  args: {
    defaultSessionId: string
    runtimeSessionId: string
    claudeSessionId: string
    cursorSessionId: string
    defaultTitle: string
    runtimeTitle: string
    claudeTitle: string
    cursorTitle: string
  }
): void {
  const cursorBucket = createHash('md5').update(DOCKER_SSH_RELAY_REMOTE_REPO_PATH).digest('hex')
  const cursorSessionDir = `/root/.cursor/chats/${cursorBucket}/${args.cursorSessionId}`
  const cursorTranscriptDir =
    `/root/.cursor/projects/${cursorLegacySlug(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}` +
    `/agent-transcripts/${args.cursorSessionId}`
  dockerExec(
    target,
    [
      'mkdir -p /root/.codex/sessions/2026/07/04',
      'mkdir -p /root/.local/share/orca/codex-runtime-home/home/sessions/2026/07/04',
      'mkdir -p /root/.claude/projects/orca',
      `mkdir -p '${cursorSessionDir}'`,
      `mkdir -p '${cursorTranscriptDir}'`
    ].join(' && ')
  )
  dockerWriteFile(
    target,
    '/root/.codex/session_index.jsonl',
    jsonLines([{ id: args.defaultSessionId, thread_name: args.defaultTitle }]),
    '600'
  )
  dockerWriteFile(
    target,
    `/root/.codex/sessions/2026/07/04/${args.defaultSessionId}.jsonl`,
    codexTranscript({
      sessionId: args.defaultSessionId,
      title: args.defaultTitle,
      cwd: DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
      timestamp: '2026-07-04T01:00:00.000Z'
    }),
    '600'
  )
  dockerWriteFile(
    target,
    `/root/.local/share/orca/codex-runtime-home/home/sessions/2026/07/04/${args.runtimeSessionId}.jsonl`,
    codexTranscript({
      sessionId: args.runtimeSessionId,
      title: args.runtimeTitle,
      cwd: DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
      timestamp: '2026-07-04T02:00:00.000Z'
    }),
    '600'
  )
  dockerWriteFile(
    target,
    `/root/.claude/projects/orca/${args.claudeSessionId}.jsonl`,
    claudeTranscript({
      sessionId: args.claudeSessionId,
      title: args.claudeTitle,
      timestamp: '2026-07-04T03:00:00.000Z'
    }),
    '600'
  )
  dockerWriteFile(
    target,
    `${cursorSessionDir}/meta.json`,
    JSON.stringify({
      createdAtMs: 1_751_588_400_000,
      updatedAtMs: 1_751_588_401_000,
      hasConversation: true,
      title: args.cursorTitle
    }),
    '600'
  )
  dockerWriteFile(target, `${cursorSessionDir}/store.db`, '', '600')
  dockerWriteFile(
    target,
    `${cursorTranscriptDir}/${args.cursorSessionId}.jsonl`,
    jsonLines([
      { role: 'user', message: { content: [{ type: 'text', text: args.cursorTitle }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }
    ]),
    '600'
  )
  dockerWriteFile(target, '/usr/local/bin/cursor-agent', '#!/bin/sh\nexit 0\n', '755')
}

function codexTranscript(args: {
  sessionId: string
  title: string
  cwd: string
  timestamp: string
}): string {
  return jsonLines([
    {
      timestamp: args.timestamp,
      type: 'session_meta',
      payload: { id: args.sessionId, cwd: args.cwd }
    },
    {
      timestamp: args.timestamp.replace(':00.000Z', ':01.000Z'),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: args.title }]
      }
    }
  ])
}

function claudeTranscript(args: { sessionId: string; title: string; timestamp: string }): string {
  return jsonLines([
    {
      sessionId: args.sessionId,
      timestamp: args.timestamp,
      type: 'user',
      message: { content: [{ type: 'text', text: args.title }] }
    },
    {
      sessionId: args.sessionId,
      timestamp: args.timestamp.replace(':00.000Z', ':01.000Z'),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: 'Remote session acknowledged.' }
    }
  ])
}

function cursorLegacySlug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}
