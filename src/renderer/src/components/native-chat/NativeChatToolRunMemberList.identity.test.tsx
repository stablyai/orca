// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import { NativeChatToolRunMemberList } from './NativeChatToolRunMemberList'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'

vi.mock('./NativeChatDiffCard', () => ({ NativeChatDiffCard: () => null }))
vi.mock('./NativeChatDiffView', () => ({ NativeChatDiffView: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function shellCall(callId: string, command: string): NativeChatToolCallBlock {
  return { type: 'tool-call', name: 'shell', callId, input: { command }, state: 'completed' }
}

function shellResult(callId: string, output: string): NativeChatToolResultBlock {
  return { type: 'tool-result', callId, output }
}

function MemberDisclosureHarness({
  blocks,
  mounted = true
}: {
  blocks: NativeChatBlock[]
  mounted?: boolean
}): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      {mounted ? (
        <NativeChatToolRunMemberList
          blocks={blocks}
          headerBlocks={blocks}
          disclosureId="message-1"
        />
      ) : null}
    </NativeChatDisclosureContext.Provider>
  )
}

function commandButton(command: string, occurrence = 0): HTMLElement {
  const button = screen.getAllByRole('button', { name: new RegExp(command) })[occurrence]
  if (!button) {
    throw new Error(`Missing command occurrence ${occurrence}: ${command}`)
  }
  return button
}

function duplicateShellBlocks(command: string, firstOutput: string, secondOutput: string) {
  return [
    shellCall('duplicate', command),
    shellCall('duplicate', command),
    shellResult('duplicate', firstOutput),
    shellResult('duplicate', secondOutput)
  ]
}

describe('tool member provider identity', () => {
  it('opens duplicate-ID calls independently and retains their rows across updates and removals', () => {
    const prefix = [shellCall('prefix', 'echo prefix'), shellResult('prefix', 'PREFIX_OUTPUT')]
    const original = duplicateShellBlocks('echo repeated', 'FIRST_OUTPUT', 'SECOND_OUTPUT')
    const { rerender } = render(<MemberDisclosureHarness blocks={[...prefix, ...original]} />)
    const first = commandButton('echo repeated')
    const second = commandButton('echo repeated', 1)

    fireEvent.click(second)
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText('FIRST_OUTPUT')).toBeNull()
    expect(screen.getByText('SECOND_OUTPUT')).toBeTruthy()

    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('FIRST_OUTPUT')).toBeTruthy()

    fireEvent.click(first)
    const updated = duplicateShellBlocks('echo updated', 'FIRST_UPDATED', 'SECOND_UPDATED')
    rerender(<MemberDisclosureHarness blocks={[...prefix, ...updated]} />)
    expect(commandButton('echo updated')).toBe(first)
    expect(commandButton('echo updated', 1)).toBe(second)
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('SECOND_UPDATED')).toBeTruthy()

    rerender(<MemberDisclosureHarness blocks={updated} />)
    expect(commandButton('echo updated')).toBe(first)
    expect(commandButton('echo updated', 1)).toBe(second)
    expect(second.getAttribute('aria-expanded')).toBe('true')

    const firstOnly = [
      shellCall('duplicate', 'echo updated'),
      shellResult('duplicate', 'FIRST_UPDATED')
    ]
    rerender(<MemberDisclosureHarness blocks={firstOnly} />)
    expect(commandButton('echo updated')).toBe(first)
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getAllByRole('button')).toHaveLength(1)

    rerender(<MemberDisclosureHarness blocks={updated} />)
    expect(commandButton('echo updated')).toBe(first)
    expect(commandButton('echo updated', 1).getAttribute('aria-expanded')).toBe('true')

    rerender(<MemberDisclosureHarness blocks={updated} mounted={false} />)
    rerender(<MemberDisclosureHarness blocks={updated} />)
    expect(commandButton('echo updated').getAttribute('aria-expanded')).toBe('false')
    expect(commandButton('echo updated', 1).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a unique call mounted and open as its input changes and its result arrives', () => {
    const command = `echo ${'long argument '.repeat(12)}`
    const call = { ...shellCall('unique', command), state: 'running' as const }
    const { rerender } = render(<MemberDisclosureHarness blocks={[call]} />)
    const button = commandButton('echo long argument')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')

    rerender(
      <MemberDisclosureHarness
        blocks={[shellCall('unique', 'echo completed'), shellResult('unique', 'COMPLETE_OUTPUT')]}
      />
    )
    expect(commandButton('echo completed')).toBe(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('COMPLETE_OUTPUT')).toBeTruthy()
  })

  it('keeps duplicate occurrences separate from a provider ID containing an occurrence suffix', () => {
    const blocks = [
      ...duplicateShellBlocks('echo repeated', 'FIRST_OUTPUT', 'SECOND_OUTPUT'),
      shellCall('duplicate:1', 'echo distinct'),
      shellResult('duplicate:1', 'DISTINCT_OUTPUT')
    ]
    render(<MemberDisclosureHarness blocks={blocks} />)
    fireEvent.click(commandButton('echo repeated', 1))
    expect(commandButton('echo repeated').getAttribute('aria-expanded')).toBe('false')
    expect(commandButton('echo distinct').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('SECOND_OUTPUT')).toBeTruthy()
    expect(screen.queryByText('DISTINCT_OUTPUT')).toBeNull()

    fireEvent.click(commandButton('echo distinct'))
    expect(screen.getByText('DISTINCT_OUTPUT')).toBeTruthy()
    expect(commandButton('echo repeated', 1).getAttribute('aria-expanded')).toBe('true')
  })
})
