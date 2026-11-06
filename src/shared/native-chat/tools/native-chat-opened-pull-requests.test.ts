import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatToolCallBlock } from '../native-chat-types'
import {
  nativeChatTurnOpenedPullRequests,
  pullRequestsOpenedBy
} from './native-chat-opened-pull-requests'

// What `gh pr create` prints: a progress line on stderr, then the new pull request's URL alone.
const GH_CREATE_OUTPUT =
  '\nCreating pull request for brennan/fix into main in stablyai/orca\n\nhttps://github.com/stablyai/orca/pull/38712\n'

function numbers(script: string, output: string): number[] {
  return pullRequestsOpenedBy(script, output).map(({ number }) => number)
}

describe('pullRequestsOpenedBy', () => {
  it('takes the URL a create command printed, also after a push and with env prefixes', () => {
    expect(numbers('gh pr create --fill', GH_CREATE_OUTPUT)).toEqual([38712])
    expect(
      numbers(
        'git push -u origin HEAD && GH_PROMPT_DISABLED=1 gh pr create --fill',
        GH_CREATE_OUTPUT
      )
    ).toEqual([38712])
    expect(
      pullRequestsOpenedBy(
        'glab mr create --fill',
        'https://gitlab.com/group/sub/proj/-/merge_requests/7\n'
      )
    ).toEqual([
      {
        provider: 'gitlab',
        url: 'https://gitlab.com/group/sub/proj/-/merge_requests/7',
        slug: { host: 'gitlab.com', path: 'group/sub/proj' },
        number: 7
      }
    ])
  })

  it('takes nothing a create command did not open', () => {
    // Printed, not run.
    expect(numbers('echo "gh pr create"', GH_CREATE_OUTPUT)).toEqual([])
    // An existing pull request the command names.
    expect(numbers('gh pr create --fill || gh pr view 38712', GH_CREATE_OUTPUT)).toEqual([])
    // Listing commands print other pull requests' URLs.
    expect(numbers('gh pr create --fill; gh pr list', GH_CREATE_OUTPUT)).toEqual([])
    // A URL inside prose is not the line gh prints.
    expect(
      numbers('gh pr create --fill', 'a pull request already exists: https://github.com/o/r/pull/9')
    ).toEqual([])
    // More URLs than create commands means something else printed them.
    expect(
      numbers(
        'gh pr create --fill',
        'https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2\n'
      )
    ).toEqual([])
    // Only the host whose create command ran.
    expect(numbers('gh pr create --fill', 'https://gitlab.com/g/p/-/merge_requests/3\n')).toEqual(
      []
    )
  })
})

function bashTurn(
  input: unknown,
  output: string,
  extra: Pick<NativeChatToolCallBlock, 'state'> = {}
): NativeChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      { type: 'tool-call', name: 'Bash', input, callId: 'c1', ...extra },
      { type: 'tool-result', output, callId: 'c1' }
    ]
  } as NativeChatMessage
}

function openedIn(message: NativeChatMessage): number[] {
  return (
    nativeChatTurnOpenedPullRequests([message], ['t1'])
      .byTurn.get('t1')
      ?.map(({ number }) => number) ?? []
  )
}

describe('nativeChatTurnOpenedPullRequests', () => {
  it("reads each agent's command shape", () => {
    // Claude's Bash tool and ACP agents' raw input.
    expect(openedIn(bashTurn({ command: 'gh pr create --fill' }, GH_CREATE_OUTPUT))).toEqual([
      38712
    ])
    // Codex app-server: one string through a login shell.
    expect(
      openedIn(bashTurn({ command: "/bin/zsh -lc 'gh pr create --fill'" }, GH_CREATE_OUTPUT))
    ).toEqual([38712])
    // Codex transcript: argv, whose script must stay one word.
    expect(
      openedIn(
        bashTurn(
          JSON.stringify({ command: ['bash', '-lc', 'gh pr create --title "a b" --body x'] }),
          GH_CREATE_OUTPUT
        )
      )
    ).toEqual([38712])
  })

  it('counts a finished call that failed after opening, but not one still running', () => {
    const chained = { command: 'gh pr create --fill && gh pr checks --watch' }
    expect(openedIn(bashTurn(chained, GH_CREATE_OUTPUT, { state: 'failed' }))).toEqual([38712])
    expect(openedIn(bashTurn(chained, GH_CREATE_OUTPUT, { state: 'running' }))).toEqual([])
  })

  it('asks for a clipped create output whole, and skips a partly loaded turn', () => {
    const clipped = bashTurn({ command: 'gh pr create --fill' }, 'hook output…')
    ;(clipped.blocks[1] as { fullOutputItemId?: string }).fullOutputItemId = 'item-7'
    expect(nativeChatTurnOpenedPullRequests([clipped], ['t1']).clippedCreateOutputs).toEqual([
      'item-7'
    ])
    expect(
      nativeChatTurnOpenedPullRequests([clipped], ['t1'], {
        fullOutputs: new Map([['item-7', GH_CREATE_OUTPUT]])
      }).byTurn.get('t1')?.[0]?.number
    ).toBe(38712)
    const whole = bashTurn({ command: 'gh pr create --fill' }, GH_CREATE_OUTPUT)
    expect(
      nativeChatTurnOpenedPullRequests([whole], ['t1'], { partialTurnKey: 't1' }).byTurn.size
    ).toBe(0)
  })
})
