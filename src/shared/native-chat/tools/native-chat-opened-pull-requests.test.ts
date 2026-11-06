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
  extra: Pick<NativeChatToolCallBlock, 'state'> = {},
  fullOutputItemId?: string
): NativeChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      { type: 'tool-call', name: 'Bash', input, callId: 'c1', ...extra },
      {
        type: 'tool-result',
        output,
        callId: 'c1',
        ...(fullOutputItemId ? { fullOutputItemId } : {})
      }
    ]
  }
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
    // Older Codex transcripts keep the output as JSON.
    expect(
      openedIn(
        bashTurn(
          { command: ['bash', '-lc', 'gh pr create --fill'] },
          JSON.stringify({ output: GH_CREATE_OUTPUT, metadata: { exit_code: 0 } })
        )
      )
    ).toEqual([38712])
  })

  it("reads each agent's recorded gh pr create call", () => {
    // Recorded from the renderer on Windows QA of this change: Claude's Bash call, and Codex's
    // shell call through PowerShell, whose output ends lines in CRLF.
    const claude = bashTurn(
      { command: 'gh pr create --fill', description: 'Create a pull request from commit info' },
      'Creating pull request for brennanb2025/chat-pr-card into main in stablyai/orca\n\nhttps://github.com/stablyai/orca/pull/38750',
      { state: 'completed' }
    )
    const codex = bashTurn(
      {
        command:
          '"C:\\\\Users\\\\neil\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps\\\\pwsh.exe" -Command \'gh pr create --fill\'',
        cwd: 'C:\\Users\\neil\\orca\\workspaces\\orca\\qa-pr-38750-qg'
      },
      'Creating pull request for brennanb2025/chat-pr-card into main in stablyai/orca\r\nhttps://github.com/stablyai/orca/pull/38750\r\n',
      { state: 'completed' }
    )
    expect([openedIn(claude), openedIn(codex)]).toEqual([[38750], [38750]])
    // Options before -Command, and PowerShell's own backtick escapes around quoted text.
    expect(
      openedIn(
        bashTurn(
          {
            command:
              "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'gh pr create --fill'"
          },
          GH_CREATE_OUTPUT
        )
      )
    ).toEqual([38712])
    expect(
      openedIn(
        bashTurn(
          {
            command: 'pwsh -Command \'Write-Output "`"; gh pr create; `""; Get-Content pr-url.txt\''
          },
          GH_CREATE_OUTPUT
        )
      )
    ).toEqual([])
    // cmd.exe's own wrapper.
    expect(
      openedIn(
        bashTurn(
          { command: 'C:\\Windows\\System32\\cmd.exe /d /s /c "gh pr create --fill"' },
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

  it('decides a clipped create output from its whole text, and skips a partly loaded turn', () => {
    // The head already holds a URL, but what follows the cut can disqualify it.
    const clipped = bashTurn({ command: 'gh pr create --fill' }, GH_CREATE_OUTPUT, {}, 'item-7')
    const pending = nativeChatTurnOpenedPullRequests([clipped], ['t1'])
    expect(pending.clippedCreateOutputs).toEqual(['item-7'])
    expect(pending.byTurn.size).toBe(0)
    const withOutputs = (whole: string | null): number[] =>
      nativeChatTurnOpenedPullRequests([clipped], ['t1'], {
        fullOutputs: new Map([['item-7', whole]])
      })
        .byTurn.get('t1')
        ?.map(({ number }) => number) ?? []
    expect(withOutputs(`${GH_CREATE_OUTPUT}https://github.com/o/r/pull/2\n`)).toEqual([])
    // A host that can't give it whole leaves the head as the evidence.
    expect(withOutputs(null)).toEqual([38712])
    const whole = bashTurn({ command: 'gh pr create --fill' }, GH_CREATE_OUTPUT)
    expect(
      nativeChatTurnOpenedPullRequests([whole], ['t1'], { partialTurnKey: 't1' }).byTurn.size
    ).toBe(0)
  })

  it('rescans only rows it has not seen, so a streaming reply stays cheap', () => {
    const cache = new WeakMap()
    const old = bashTurn({ command: 'gh pr create --fill' }, GH_CREATE_OUTPUT)
    nativeChatTurnOpenedPullRequests([old], ['t1'], { cache })
    Object.defineProperty(old, 'blocks', {
      get: () => {
        throw new Error('an unchanged row was scanned again')
      }
    })
    const streaming: NativeChatMessage = {
      id: 'm2',
      role: 'assistant',
      timestamp: 2,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'ok' }]
    }
    const again = nativeChatTurnOpenedPullRequests([old, streaming], ['t1', 't1'], { cache })
    expect(again.byTurn.get('t1')?.map(({ number }) => number)).toEqual([38712])
  })
})
