import '../appearance/native-chat-appearance.css'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from '../composer/controls/NativeChatComposerNotices'
import { NativeChatShellRunCards } from './NativeChatShellRunList'
import { registerNativeChatShellHost, runNativeChatShellCommand } from './native-chat-shell-runs'
import type { AgentSessionShellCommandFrame } from '../../../../../shared/rpc-contract/structured-agent-session-shell-command-params'

const exit = (exitCode: number): AgentSessionShellCommandFrame => ({
  type: 'exit',
  exitCode,
  timedOut: false,
  outputTruncated: false
})

const FRAMES: Record<string, AgentSessionShellCommandFrame[]> = {
  pwd: [
    { type: 'output', chunks: [{ stream: 'stdout', text: '/Users/me/projects/orca\n' }] },
    exit(0)
  ],
  'git status': [
    {
      type: 'output',
      chunks: [
        { stream: 'stdout', text: 'On branch main\n' },
        { stream: 'stderr', text: 'warning: could not open directory .cache/\n' }
      ]
    },
    exit(128)
  ],
  'ls -la': [
    { type: 'started', directory: 'packages/app' },
    {
      type: 'output',
      chunks: [
        {
          stream: 'stdout',
          text: Array.from(
            { length: 20 },
            (_, index) => `-rw-r--r--  1 me  staff  ${index}  file-${index}.ts\n`
          ).join('')
        }
      ]
    },
    exit(0)
  ],
  'npm test': [{ type: 'output', chunks: [{ stream: 'stdout', text: '> vitest run\n' }] }]
}

const seeded = new Set<string>()

function seed(anchor: string, commands: readonly string[]): void {
  if (seeded.has(anchor)) {
    return
  }
  seeded.add(anchor)
  registerNativeChatShellHost(anchor, {
    run: (command, sink) => {
      FRAMES[command]?.forEach((frame) => sink.frame(frame))
      return () => {}
    },
    anchor: () => ({ id: anchor, awaitingTurn: false })
  })
  commands.forEach((command) => runNativeChatShellCommand(anchor, command))
}

export const cards = defineFixture({
  width: 720,
  setup: () => seed('fixture-cards', ['pwd', 'git status', 'ls -la', 'npm test']),
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatShellRunCards anchorIds={['fixture-cards']} />
    </div>
  )
})

export const shellModeComposer = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatComposerNotices notices={[]} shellMode />
      <div className="native-chat-composer-frame native-chat-composer-shell rounded-xl border border-chat-composer-border bg-chat-composer-surface p-3 font-mono text-sm text-chat-foreground shadow-xs">
        ! git status
      </div>
    </div>
  )
})
