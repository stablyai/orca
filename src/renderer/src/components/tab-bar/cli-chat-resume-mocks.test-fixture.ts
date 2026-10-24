import type { Mock } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'

export type CliChatResumeTestMocks = {
  source: CliChatResumeSource | null
  realSource: boolean
  frameDrawn: boolean
  sourceCapability: Mock
  createCapability: Mock
  call: Mock
  toast: Mock
  success: Mock
  activate: Mock<() => Promise<boolean>>
  activateVerified: Mock<() => Promise<string>>
  switchCapability: Mock<() => Promise<boolean>>
  exitWatchers: Map<string, () => void>
  rpc: Mock<(...args: unknown[]) => Promise<object>>
  inspect: Mock<(ptyId: string) => Promise<{ foregroundProcessEvidence?: unknown }>>
}

export function seedCliChatResumeRpc(mocks: CliChatResumeTestMocks): void {
  mocks.rpc.mockImplementation(async (_target, method) =>
    method === 'terminal.resolvePane'
      ? {
          terminal: {
            handle: 'handle-1',
            ptyId: 'pty-1',
            incarnationId: 'i1',
            presentation: {
              identity: {
                worktreeId: 'wt-1',
                tabId: mocks.source?.tabId ?? 'tab-1',
                leafId: mocks.source?.paneKey.split(':')[1] ?? 'leaf-1',
                createdAt: 1,
                generation: 0,
                hasLeaf: true,
                ptyId: 'pty-1',
                incarnationId: 'i1'
              },
              holders: []
            }
          }
        }
      : { close: { ptyKilled: true } }
  )
}
