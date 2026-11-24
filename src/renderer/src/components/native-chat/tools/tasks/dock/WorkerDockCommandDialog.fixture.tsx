// Hands-on evidence for the Worker Dock command dialog: the real strip, row, dialog and Copy, with a
// reader holding seeded credit and a stubbed local host. All commands, paths and names are invented.
//
// While a dialog is open: Alt+Shift+C shows or clears a crew; Alt+Shift+R revokes the reader's
// credit (the next frame would withdraw the command). The page shows the bytes the last Copy wrote.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../../../appearance/native-chat-appearance-style'
import { NativeChatStructuredSessionStatus } from '../NativeChatStructuredSessionStatus'
import {
  NativeChatCrewContext,
  type NativeChatCrewSource
} from '../../../../orchestration-crew/use-native-chat-crew'
import type { StructuredSessionBackgroundTasksView } from '../../../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import type { AgentChildWorkView } from '../../../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'
import { createCommandDetailAuthority } from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'
import {
  getOrCreateStructuredReadOwner,
  retireStructuredAgentSessionReadOwner,
  structuredReadOwnerKey
} from '../../../session/structured/read/structured-agent-session-read-owner-registry'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

const SESSION = 'fixture-command-session'
const LOCAL: RuntimeClientTarget = { kind: 'local' }

const COMMANDS = {
  long: {
    preview:
      '/fixture/bin/bash -lc \'"${FIXTURE_CLI:-fixture}" orchestration send --to team:Reviewer --type question --subject "Check the sample release" --body-file /tmp/sample-brief.md && fixture-check --suite smoke --reporter summary && fixture-format --input sample-build --output sample-report…',
    exact:
      '"${FIXTURE_CLI:-fixture}" orchestration send --to team:Reviewer --type question --subject "Check the sample release" --body-file /tmp/sample-brief.md && fixture-check --suite smoke --reporter summary && fixture-format --input sample-build --output sample-report --check && fixture-verify --manifest sample-manifest && fixture-pack --input sample-build --format archive'
  },
  heredoc: {
    preview:
      "/fixture/bin/bash -lc 'cd ~/projects/sample-web && git fetch origin main && git rebase origin/main && pnpm install --frozen-lockfile && pnpm -w typecheck && cat > /tmp/sample-notes.md <<'\\''EOF'\\''…",
    exact: [
      'cd ~/projects/sample-web && git fetch origin main && git rebase origin/main && pnpm install --frozen-lockfile && pnpm -w typecheck',
      "cat > /tmp/sample-notes.md <<'EOF'",
      ...Array.from(
        { length: 28 },
        (_, index) =>
          `  - step ${index + 1}: run the sample suite '${index % 3 === 0 ? 'smoke' : 'unit'}' and keep  two  spaces`
      ),
      'EOF',
      'pnpm vitest run src/components/sample --reporter=dot --coverage=false 2>&1 | tail -80'
    ].join('\n')
  },
  short: { preview: "/fixture/bin/zsh -lc 'git status --short'", exact: 'git status --short' }
} as const

type Scene = keyof typeof COMMANDS

const TUPLE = { childWorkId: 'fixture-child-1', invocationId: 'fixture-run-1', generation: 1 }

function view(scene: Scene): AgentChildWorkView {
  return {
    id: TUPLE.childWorkId,
    providerId: 'codex-command:primary:fixture-call-1',
    kind: 'command',
    description: COMMANDS[scene].preview,
    state: 'working',
    membership: 'live',
    firstObservedAt: Date.now() - 154_000,
    observedAt: Date.now(),
    stoppable: true,
    invocation: { invocationId: TUPLE.invocationId, generation: TUPLE.generation }
  }
}

function tasks(scene: Scene): StructuredSessionBackgroundTasksView {
  return {
    show: true,
    isMonitoring: true,
    tasks: [],
    settledTasks: [],
    children: [view(scene)],
    supportsStop: true,
    offersStopAll: false,
    incomplete: false
  }
}

function roster(scene: Scene, fence: number, available: boolean): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: SESSION,
    fence,
    batch: {
      cursor: { epoch: 'fixture', sequence: 1 },
      items: [],
      removedItemIds: [],
      submissions: []
    },
    backgroundTasks: {
      state: 'monitoring',
      children: [view(scene)],
      ...(available ? { commandDetailsAvailable: [TUPLE] } : {})
    }
  } as AgentSessionSubscribeEvent
}

/** The reader as the live stream leaves it: credited on one scope, or holding none. */
function seedReader(scene: Scene, credited: boolean) {
  retireStructuredAgentSessionReadOwner(SESSION, LOCAL)
  const authority = createCommandDetailAuthority()
  getOrCreateStructuredReadOwner(
    structuredReadOwnerKey(SESSION, LOCAL),
    () =>
      ({
        commandDetails: authority
      }) as never
  )
  let scope = { transport: {}, generation: 1 }
  const connect = () => {
    scope = { transport: {}, generation: 1 }
    authority.invalidate(scope)
    authority.seed(scope, { epoch: 'fixture', sequence: 1 })
    authority.observe(scope, roster(scene, 3, credited))
  }
  connect()
  return {
    // Contact loss then a fresh stream with the same tuple: a new opening is needed.
    revoke: () => {
      authority.invalidate(null)
      connect()
    }
  }
}

const copies = { last: null as string | null, listeners: new Set<() => void>() }

function stubHost(scene: Scene): void {
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) =>
      method === 'agentSession.backgroundCommand'
        ? { ok: true, result: { command: COMMANDS[scene].exact } }
        : { ok: false, error: { code: 'runtime_error', message: method } }
  })
  const ui: unknown = window.api.ui
  Reflect.set(window.api, 'ui', {
    ...(typeof ui === 'object' ? ui : {}),
    writeClipboardText: async (text: string) => {
      copies.last = text
      copies.listeners.forEach((listener) => listener())
      await navigator.clipboard?.writeText(text).catch(() => {})
    }
  })
}

function crewSource(): NativeChatCrewSource & { set: (on: boolean) => void } {
  let on = false
  const listeners = new Set<() => void>()
  const states = {
    off: { summary: { status: 'unknown', agents: 0, needsYou: 0 }, rows: null },
    on: { summary: { status: 'ok', agents: 1, needsYou: 0 }, rows: null }
  } as const
  return {
    target: LOCAL,
    canMention: false,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read: () => (on ? states.on : states.off) as never,
    wantRows: () => () => {},
    mention: () => {},
    insertName: () => {},
    set: (next) => {
      on = next
      listeners.forEach((listener) => listener())
    }
  }
}

function CommandStrip({ scene, credited }: { scene: Scene; credited: boolean }) {
  const [reader] = useState(() => seedReader(scene, credited))
  const [crew] = useState(crewSource)
  const [crewOn, setCrewOn] = useState(false)
  const copied = useSyncExternalStore(
    (listener) => {
      copies.listeners.add(listener)
      return () => copies.listeners.delete(listener)
    },
    () => copies.last
  )
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey) {
        return
      }
      if (event.code === 'KeyC') {
        setCrewOn((on) => {
          crew.set(!on)
          return !on
        })
      } else if (event.code === 'KeyR') {
        reader.revoke()
      }
    }
    window.addEventListener('keydown', onKey, true)
    Reflect.set(window, '__workerDockCommandFixture', {
      crew: (on: boolean) => {
        crew.set(on)
        setCrewOn(on)
      },
      revoke: reader.revoke,
      lastCopied: () => copies.last
    })
    return () => window.removeEventListener('keydown', onKey, true)
  }, [crew, reader])
  return (
    <NativeChatCrewContext.Provider value={crew}>
      <div
        className="native-chat-appearance bg-chat-canvas p-3"
        style={nativeChatAppearanceStyle({})}
      >
        <div className="relative h-24">
          <NativeChatStructuredSessionStatus
            sessionId={SESSION}
            target={LOCAL}
            paneKey="fixture-pane"
            isVisible
            backgroundTasks={tasks(scene)}
            stop={{ stoppingTaskIds: new Set(), stoppingAll: false, onStop: () => {} }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Crew {crewOn ? 'shown' : 'hidden'} · Alt+Shift+C crew · Alt+Shift+R revoke
        </p>
        <pre
          data-fixture-last-copy=""
          className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground"
        >
          {copied === null ? 'Nothing copied yet' : `Last copy: ${JSON.stringify(copied)}`}
        </pre>
      </div>
    </NativeChatCrewContext.Provider>
  )
}

async function openCommand(frame: HTMLElement) {
  frame.querySelector<HTMLButtonElement>('[data-worker-dock-pill]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const row = [...frame.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) =>
      !button.hasAttribute('data-worker-dock-pill') &&
      /fixture|git status/.test(button.textContent ?? '')
  )
  row?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

function scene(name: Scene, credited: boolean, width: number, open = true) {
  return defineFixture({
    width,
    setup: () => stubHost(name),
    render: () => <CommandStrip scene={name} credited={credited} />,
    ...(open ? { interact: openCommand } : {})
  })
}

export const commandLong600 = scene('long', true, 600)
export const commandLong320 = scene('long', true, 320)
export const commandHeredoc600 = scene('heredoc', true, 600)
export const commandHeredoc320 = scene('heredoc', true, 320)
export const commandShort600 = scene('short', true, 600)
export const commandShort320 = scene('short', true, 320)
export const commandFallback600 = scene('long', false, 600)
export const commandFallback320 = scene('long', false, 320)
/** Closed: open it yourself with a real click or keyboard. */
export const commandHandsOn = scene('long', true, 600, false)
export const commandHandsOnHeredoc = scene('heredoc', true, 600, false)
