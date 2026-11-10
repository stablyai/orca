import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMcpPanel } from './NativeChatMcpPanel'
import { NativeChatClaudeTerminalCommand } from './NativeChatClaudeTerminalCommand'
import { NativeChatClaudeSettingsCommand } from './NativeChatClaudeSettingsCommand'
import { NativeChatComposer } from '../NativeChatComposer'
import { writeNativeChatDraftCache } from '../../drafts/native-chat-draft-views'
import type { AgentSessionMcpServer } from '../../../../../../shared/agent-session/agent-session-mcp'
import { AgentSessionMcpParams } from '../../../../../../shared/rpc-contract/agent-session-mcp-params'
import type { SessionOptionDescriptor } from '../../../../../../shared/native-chat/input/native-chat-session-options'

function setupMcp(
  initialServers: AgentSessionMcpServer[] = [
    { name: 'figma', status: 'needs-auth', canAuthenticate: true },
    { name: 'docs', status: 'connected', canAuthenticate: false },
    { name: 'local-tools', status: 'disabled', canAuthenticate: false }
  ]
) {
  let servers = initialServers
  window.api.runtime.call = async ({ params }) => {
    const operation = AgentSessionMcpParams.safeParse(params).data?.operation
    if (operation && operation.action !== 'status') {
      await new Promise((resolve) => setTimeout(resolve, 150))
      servers = servers.map((server) =>
        server.name !== operation.server
          ? server
          : {
              ...server,
              status: operation.action === 'toggle' && !operation.enabled ? 'disabled' : 'connected'
            }
      )
    }
    return {
      id: 'fixture',
      ok: true,
      _meta: { runtimeId: 'fixture' },
      result: { status: 'ok', servers }
    }
  }
}

export const mcp = defineFixture({
  width: 720,
  setup: setupMcp,
  render: () => (
    <div className="native-chat-appearance bg-background p-4">
      <NativeChatMcpPanel
        transport={{ sessionId: 'fixture-chat', runtimeEnvironmentId: null }}
        fallback={null}
      />
    </div>
  )
})

export const narrowMcp = defineFixture({ ...mcp, width: 360 })

export const splitMcp = defineFixture({
  ...mcp,
  width: 480,
  setup: () =>
    setupMcp([
      {
        name: 'figma-design-system-review-preview-environment',
        status: 'needs-auth',
        canAuthenticate: true
      },
      ...Array.from({ length: 12 }, (_, index): AgentSessionMcpServer => ({
        name: `workspace-docs-${index + 1}`,
        status: index === 0 ? 'failed' : 'connected',
        canAuthenticate: false
      }))
    ])
})

function SettingsFixture() {
  const [options, setOptions] = useState<SessionOptionDescriptor[]>([
    {
      id: 'permissionMode',
      label: 'Permissions',
      category: 'mode',
      transport: 'agent-session',
      valueSource: 'reported',
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'ask',
        choices: [
          { value: 'ask', label: 'Ask' },
          { value: 'full-access', label: 'Full access' }
        ]
      }
    }
  ])
  return (
    <div className="native-chat-appearance bg-background p-4">
      <NativeChatClaudeSettingsCommand
        command="permissions"
        transport={{
          optionSnapshot: options,
          optionsSurface: {
            admits: () => true,
            getSnapshot: () => options,
            subscribe: () => () => {},
            setOption: async (_id, value) => {
              const next = options.map((option) => ({
                ...option,
                kind: {
                  ...option.kind,
                  type: 'select' as const,
                  currentValue: String(value),
                  choices: option.kind.type === 'select' ? option.kind.choices : []
                }
              }))
              setOptions(next)
              return { snapshot: next }
            },
            invokeAction: async () => ({ snapshot: options })
          }
        }}
      />
    </div>
  )
}

export const permissions = defineFixture({ width: 360, render: () => <SettingsFixture /> })

let terminalDraft: string | null = ''
export const terminalMenu = defineFixture({
  width: 720,
  setup: () => {
    terminalDraft = ''
    window.api.pty.writeAccepted = async (_pty, data) => {
      if (data === '\r') {
        terminalDraft = null
      }
      return true
    }
  },
  render: () => (
    <div className="native-chat-appearance bg-background p-4">
      <NativeChatClaudeTerminalCommand
        command="mcp"
        ptyId="fixture-pty"
        readDraft={() => terminalDraft}
        readScreen={() =>
          'Manage MCP servers\n\n❯ figma · needs authentication\n  docs · connected\n\nEnter to select · Esc to go back'
        }
        disabled={false}
        remote
      />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
    await new Promise<void>((resolve, reject) => {
      const ready = () =>
        [...frame.querySelectorAll('button')].some(
          (button) => button.getAttribute('aria-label') === 'Next' && !button.disabled
        )
      const observer = new MutationObserver(() => {
        if (ready()) {
          observer.disconnect()
          clearTimeout(timer)
          resolve()
        }
      })
      const timer = setTimeout(() => {
        observer.disconnect()
        reject(new Error('Fixture command input did not settle'))
      }, 5000)
      observer.observe(frame, { subtree: true, childList: true, attributes: true })
      if (ready()) {
        observer.disconnect()
        clearTimeout(timer)
        resolve()
      }
    })
  }
})

export const terminalComposer = defineFixture({
  width: 720,
  setup: () => {
    writeNativeChatDraftCache('claude-command-fixture', '/mcp')
    terminalDraft = ''
    window.api.pty.writeAccepted = async (_pty, data) => {
      if (data === '\r') {
        terminalDraft = null
      }
      if (data === '\x1b') {
        terminalDraft = ''
      }
      return true
    }
  },
  render: () => (
    <div className="native-chat-appearance bg-background p-4">
      <NativeChatComposer
        terminalTabId="claude-command-tab"
        paneKey="claude-command-fixture"
        targetPtyId="fixture-pty"
        agent="claude"
        readTerminalScreen={() =>
          terminalDraft === null
            ? 'Manage MCP servers\n\n❯ figma · needs authentication\n\nEnter to select · Esc to go back'
            : '❯ '
        }
        launchSeed={{
          launchDraft: null,
          launchDraftResolved: true,
          ownsTabWideLaunchDraft: false,
          readTerminalDraft: () => terminalDraft
        }}
      />
    </div>
  )
})

export const narrowTerminalComposer = defineFixture({ ...terminalComposer, width: 360 })
export const splitTerminalComposer = defineFixture({ ...terminalComposer, width: 480 })
export const wideTerminalComposer = defineFixture({ ...terminalComposer, width: 960 })
