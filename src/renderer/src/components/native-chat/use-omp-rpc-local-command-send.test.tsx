// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const runOmpLocalCommand = vi.hoisted(() => vi.fn())
const sendNativeChatMessage = vi.hoisted(() => vi.fn())
vi.mock('./omp-rpc-local-command-route', () => ({
  runOmpLocalCommand,
  shouldRouteOmpLocalCommand: () => true
}))
vi.mock('./native-chat-runtime-send', () => ({ sendNativeChatMessage }))

import { useOmpRpcLocalCommandSend } from './use-omp-rpc-local-command-send'

it('does not fall back to a PTY that a replacement ownership generation retired', async () => {
  let answer: (value: null) => void = () => undefined
  runOmpLocalCommand.mockReturnValueOnce(
    new Promise<null>((resolve) => {
      answer = resolve
    })
  )
  const onSlashCommand = vi.fn()
  const oldTarget = () => ({ settings: {} as never, ptyId: 'pty-old' })
  const hook = renderHook(
    ({ resolveTarget, ompRpcCwd }) =>
      useOmpRpcLocalCommandSend({
        agent: 'omp',
        ompRpcCwd,
        resolveTarget,
        onSlashCommand
      }),
    { initialProps: { resolveTarget: oldTarget, ompRpcCwd: '/work' as string | null } }
  )

  act(() => expect(hook.result.current('/usage')).toBe(true))
  hook.rerender({ resolveTarget: oldTarget, ompRpcCwd: null })
  await act(async () => answer(null))

  expect(sendNativeChatMessage).not.toHaveBeenCalled()
  expect(onSlashCommand).not.toHaveBeenCalled()
})
