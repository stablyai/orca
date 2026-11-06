import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatToolCallBlock } from '../native-chat-types'
import {
  nativeChatTurnOpenedPullRequests,
  pullRequestsOpenedBy,
  type NativeChatOpenedPullRequestsCache
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
    // A shell argv's arguments after its script are `$0` and `$1`, never commands.
    expect(
      openedIn(
        bashTurn({ command: ['bash', '-lc', 'gh pr create --fill', 'argv0'] }, GH_CREATE_OUTPUT)
      )
    ).toEqual([38712])
    expect(
      openedIn(
        bashTurn(
          { command: ['bash', '-lc', 'echo "$PR_URL"', '; gh pr create --fill'] },
          GH_CREATE_OUTPUT
        )
      )
    ).toEqual([])
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
    const cache: NativeChatOpenedPullRequestsCache = new WeakMap()
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

const GH_CREATE_OUTPUT_CRLF =
  'Creating pull request for brennanb2025/chat-pr-card into main in stablyai/orca \r\nhttps://github.com/stablyai/orca/pull/38750\r\n'

describe('PowerShell create commands', () => {
  const opened = (command: unknown): number[] => openedIn(bashTurn({ command }, GH_CREATE_OUTPUT))

  it('never reads text PowerShell prints as a create', () => {
    expect(
      opened('pwsh -Command \'Write-Output "`"; gh pr create; `""; Get-Content pr-url.txt\'')
    ).toEqual([])
    // A backtick inside single quotes is literal, so the next quote still closes the string.
    expect(
      opened([
        'pwsh',
        '-Command',
        "Write-Output '`'; Write-Output '; gh pr create;'; Get-Content u.txt"
      ])
    ).toEqual([])
    expect(
      opened([
        'pwsh',
        '-Command',
        '$body = @\'\r\nsay "hi" then gh pr create\r\n\'@\r\nWrite-Output $body'
      ])
    ).toEqual([])
  })

  it("reads Codex on Windows' recorded calls, including a quote inside the script", () => {
    // Recorded on Windows QA of this change, as the renderer received them.
    const pwsh = '"C:\\\\Users\\\\neil\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps\\\\pwsh.exe"'
    const recorded: [string, string, number[]][] = [
      [`${pwsh} -Command 'gh pr create --fill'`, GH_CREATE_OUTPUT_CRLF, [38750]],
      [
        `${pwsh} -Command "gh pr create --title \\"Don't stop\\" --fill"`,
        GH_CREATE_OUTPUT_CRLF,
        [38750]
      ],
      [`${pwsh} -Command "Write-Output 'gh pr create'"`, 'gh pr create\r\n', []],
      // As Codex's argv join writes a script ending in a backslash, and one holding both `$` and
      // an apostrophe, which it splits into differently quoted pieces of one word.
      [
        String.raw`${pwsh} -Command "gh pr create --fill; Set-Location C:\\"`,
        GH_CREATE_OUTPUT_CRLF,
        [38750]
      ],
      [
        String.raw`${pwsh} -Command '$t = "Don'"'t stop\"; gh pr create --title "'$t --fill'`,
        GH_CREATE_OUTPUT_CRLF,
        [38750]
      ],
      [
        String.raw`${pwsh} -Command '$u = '"'https://github.com/stablyai/orca/pull/38750'; Write-Output \"gh pr create isn't run\"; Write-Output "'$u'`,
        GH_CREATE_OUTPUT_CRLF,
        []
      ]
    ]
    for (const [command, output, expected] of recorded) {
      expect(openedIn(bashTurn({ command }, output))).toEqual(expected)
    }
  })

  it('keeps a real create through PowerShell quoting', () => {
    expect(opened(['pwsh', '-Command', "gh pr create --title 'it''s done' --fill"])).toEqual([
      38712
    ])
    expect(
      opened('powershell.exe -ExecutionPolicy "Bypass" -Command \'gh pr create --fill\'')
    ).toEqual([38712])
    // Only a whole line is unwrapped: a launch inside a command list stays text, so it is missed
    // rather than rebuilt from comments or heredocs that only mention it.
    expect(opened("pwsh -Command 'gh pr create --fill' && echo done")).toEqual([])
  })

  it('reads an escaped separator as an argument, not a command boundary', () => {
    // Only printf runs, printing `;`, `gh`, `pr`, `create` and the URL each on its own line.
    expect(
      openedIn(
        bashTurn(
          { command: String.raw`printf '%s\n' \; gh pr create "$PR_URL"` },
          ';\ngh\npr\ncreate\nhttps://github.com/stablyai/orca/pull/38712\n'
        )
      )
    ).toEqual([])
    // A line continuation is removed, as the shell does, so a create after it still starts a command.
    for (const command of [
      'git push -u origin HEAD && \\\n  gh pr create --fill',
      // Before CRLF the backslash escapes only CR, so LF still ends the command.
      'true \\\r\ngh pr create --fill'
    ]) {
      expect(openedIn(bashTurn({ command }, GH_CREATE_OUTPUT))).toEqual([38712])
    }
  })

  it('leaves cmd launches and unrecognized wrappers as text, a miss rather than a guess', () => {
    // No agent is recorded launching cmd, whose quoting POSIX analysis can't read.
    for (const command of [
      'C:\\Windows\\System32\\cmd.exe /d /s /c "gh pr create --fill"',
      String.raw`"C:\Windows\System32\cmd.exe" /c 'gh pr create --fill'`,
      ['cmd.exe', '/c', 'echo ; gh pr create --fill & type pr-url.txt'],
      'echo /bin/zsh -lc "gh pr create --fill\n$PR_URL"'
    ]) {
      expect(opened(command)).toEqual([])
    }
  })

  it('never takes a launch that a comment or heredoc only mentions, nor drops a real create', () => {
    for (const command of [
      "# example; pwsh -Command 'gh pr create --fill'\ncat pr-url.txt",
      "ls # note; pwsh -Command 'gh pr create --fill'",
      "cat <<'EOF'\npwsh -Command 'gh pr create --fill'\nEOF",
      'C:\\Windows\\System32\\cmd.exe /d /s /c "echo done" && echo "gh pr create"',
      'cmd.exe /d /s /c "echo done" && echo "; gh pr create --fill" && cat "pr-url.txt"'
    ]) {
      expect(opened(command)).toEqual([])
    }
    expect(opened('pwsh -File build.ps1 && gh pr create --fill')).toEqual([38712])
    expect(
      openedIn({
        id: 'm1',
        role: 'assistant',
        timestamp: 1,
        source: 'transcript',
        blocks: [
          {
            type: 'tool-call',
            name: 'PowerShell',
            input: { command: 'pwsh -File build.ps1; gh pr create --fill' },
            callId: 'c1'
          },
          { type: 'tool-result', output: GH_CREATE_OUTPUT, callId: 'c1' }
        ]
      })
    ).toEqual([38712])
    // A launch line followed by more statements is a script, not one launch.
    expect(
      openedIn({
        id: 'm2',
        role: 'assistant',
        timestamp: 1,
        source: 'transcript',
        blocks: [
          {
            type: 'tool-call',
            name: 'PowerShell',
            input: {
              command:
                "pwsh -Command 'Write-Output ok'\nWrite-Output '; gh pr create --fill'\nGet-Content pr-url.txt"
            },
            callId: 'c2'
          },
          { type: 'tool-result', output: GH_CREATE_OUTPUT, callId: 'c2' }
        ]
      })
    ).toEqual([])
  })

  it('keeps the evidence that disqualifies a create, and reads nothing it cannot lex', () => {
    expect(
      opened([
        'pwsh',
        '-Command',
        "gh pr create --fill; Write-Output 'https://github.com/stablyai/orca/pull/38712'"
      ])
    ).toEqual([])
    expect(opened("pwsh -Command 'gh pr create --fill; Write-Output \"oops'")).toEqual([])
    expect(opened("pwsh -Foo -Command 'gh pr create --fill'")).toEqual([])
  })

  it("reads a PowerShell tool's line as its own script, and a launch nested in it as text", () => {
    const viaPowerShellTool = (command: string): number[] =>
      openedIn({
        id: 'm1',
        role: 'assistant',
        timestamp: 1,
        source: 'transcript',
        blocks: [
          { type: 'tool-call', name: 'PowerShell', input: { command }, callId: 'c1' },
          { type: 'tool-result', output: GH_CREATE_OUTPUT, callId: 'c1' }
        ]
      })
    expect(viaPowerShellTool('gh pr create --title "it`"s" --fill')).toEqual([38712])
    expect(viaPowerShellTool('git push -u origin HEAD; gh pr create --fill')).toEqual([38712])
    for (const command of [
      "Write-Output 'gh pr create'",
      '# gh pr create --fill',
      // A launch nested in a PowerShell script isn't recorded from any agent, so it stays text.
      "pwsh -Command 'gh pr create --fill'",
      'pwsh -Command \'Write-Output ok\' # `\nWrite-Output "; gh pr create --fill`n$env:PR_URL"'
    ]) {
      expect(viaPowerShellTool(command)).toEqual([])
    }
  })
})
