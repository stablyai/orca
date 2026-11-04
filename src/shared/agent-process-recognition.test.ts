import { describe, expect, it } from 'vitest'
import { withFreshOmpLaunch } from './agent-launch/startup/omp-fresh-launch'
import { buildAgentDraftLaunchPlan } from './agent-launch/startup/tui-agent-startup'
import { detectExplicitPiAgentKindFromCommand } from './pi-agent-kind'
import {
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'

describe('agent process recognition', () => {
  it.each([
    '-r ./preload.js',
    '--require "./preload path.js"',
    '--import ./preload.mjs',
    '--loader ./loader.mjs',
    '--experimental-loader ./loader.mjs',
    '--require=./preload.js',
    '--import=./preload.mjs'
  ])('excludes a one-shot DSB npm shim after Node options %s', (options) => {
    const shim = `node ${options} /usr/lib/node_modules/@innocarpe/deepseek-build/npm/bin/dsb.js`
    expect(recognizeAgentProcessFromCommandLine(`${shim} run "task"`)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(`${shim} run "task"`, { includeHeadlessOneShot: true })
        ?.agent
    ).toBe('dsb')
    expect(recognizeAgentProcessFromCommandLine(`${shim} agent`)?.agent).toBe('dsb')
  })

  // A packaged or versioned agent binary counts as that agent for the expected-agent check.
  it('expects a packaged or versioned agent binary as that agent', () => {
    expect(isExpectedAgentProcess('codex-aarch64-ap', 'codex')).toBe(true)
    expect(isExpectedAgentProcess('grok-0.2.51', 'grok')).toBe(true)
    expect(isExpectedAgentProcess('codex-aarch64-ap', 'claude')).toBe(false)
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'recognizes fresh OMP commands and drafts in %s',
    (shell) => {
      for (const command of ['omp', 'omp launch', 'omp --model example']) {
        const generated = withFreshOmpLaunch(command, shell)
        expect(recognizeAgentProcessFromCommandLine(generated)).toEqual({
          agent: 'omp',
          processName: 'omp'
        })
        expect(detectExplicitPiAgentKindFromCommand(generated)).toBe('omp')
      }
      const draft = buildAgentDraftLaunchPlan({
        agent: 'omp',
        draft: 'task',
        cmdOverrides: {},
        platform: 'linux',
        shell
      })
      expect(recognizeAgentProcessFromCommandLine(draft?.launchCommand)).toEqual({
        agent: 'omp',
        processName: 'omp'
      })
      expect(detectExplicitPiAgentKindFromCommand(draft?.launchCommand)).toBe('omp')
    }
  )

  it('does not classify embedded fresh-launch text as an agent command', () => {
    for (const command of [
      `echo 'omp --config "$ORCA_OMP_FRESH_CONFIG"'`,
      `echo '${withFreshOmpLaunch('omp', 'posix')}'`
    ]) {
      expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
      expect(detectExplicitPiAgentKindFromCommand(command)).toBeNull()
    }
  })

  it('does not recognize Claude print-mode hook subprocesses as interactive agents', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        'claude --print --model haiku "Analyze this conversation and determine: Does the assistant have more autonomous work to do RIGHT NOW?"'
      )
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`/home/dev/.local/bin/claude -p "Context: This summary will be shown in a list"`
      )
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`C:\Users\dev\AppData\Roaming\npm\claude.exe --output-format=json "hook prompt"`
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('claude --resume abc123')).toEqual({
      agent: 'claude',
      processName: 'claude'
    })
  })

  it('does not recognize Ante headless one-shot commands as interactive agents', () => {
    expect(recognizeAgentProcessFromCommandLine('ante -p "summarize this diff"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('ante -psummarize')).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine('ante --prompt "review this for security issues"')
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine('ante --prompt=review --output-format minimal')
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('ante --resume ses_123')).toEqual({
      agent: 'ante',
      processName: 'ante'
    })
  })

  it('does not recognize wrapped Ante headless one-shot commands as interactive agents', () => {
    expect(
      recognizeAgentProcessFromCommandLine('node /Users/dev/.ante/bin/ante --prompt "review"')
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\.ante\bin\ante.cmd -p review`
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('node /Users/dev/.ante/bin/ante')).toEqual({
      agent: 'ante',
      processName: 'ante'
    })
  })

  it('does not recognize Trae headless one-shot commands as interactive agents', () => {
    expect(recognizeAgentProcessFromCommandLine('traecli -p "summarize this diff"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('traecli --print "review this"')).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine('traecli --output-format json "review this"')
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine('traecli --output-format=stream-json review')
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('traecli --resume AUTO')).toEqual({
      agent: 'trae',
      processName: 'traecli'
    })
    // Why: past `--` nothing is a flag, so this is the interactive pane Orca itself launches.
    expect(recognizeAgentProcessFromCommandLine('traecli -- "--print the release notes"')).toEqual({
      agent: 'trae',
      processName: 'traecli'
    })
  })

  // #31311: the npm install on Windows runs as node.exe, observed with this exact .bin shim path.
  it('recognizes Kimi Code launched by its npm shim on Windows', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\dev\\proj\\node_modules\\.bin/../@moonshot-ai/kimi-code/dist/main.mjs --session session_1'
      )
    ).toEqual({ agent: 'kimi', processName: 'kimi' })
    expect(recognizeAgentProcessFromCommandLine('node C:\\tools\\app\\dist\\main.mjs')).toBeNull()
  })

  it('recognizes agent CLIs launched through interpreter wrappers', () => {
    expect(
      recognizeAgentProcessFromCommandLine('node /Users/dev/.nvm/versions/node/bin/codex')
    ).toEqual({ agent: 'codex', processName: 'codex' })
    expect(
      recognizeAgentProcessFromCommandLine('node /Users/dev/.nvm/versions/node/bin/gemini')
    ).toEqual({ agent: 'gemini', processName: 'gemini' })
    expect(recognizeAgentProcessFromCommandLine('python3 /opt/homebrew/bin/hermes --tui')).toEqual({
      agent: 'hermes',
      processName: 'hermes'
    })
    expect(
      recognizeAgentProcessFromCommandLine('python3.12 /opt/homebrew/bin/hermes --tui')
    ).toEqual({
      agent: 'hermes',
      processName: 'hermes'
    })
    // Hermes' installed launcher, as macOS ps prints its multi-line -c source.
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`/home/u/.hermes/tools/python-3.14.9/bin/python3 -I -c import os, re, sys\012sys.path.insert(0, '/home/u/.hermes/hermes-agent')\012try:\012    import hermes_bootstrap\012except Exception:\012    raise\012from hermes_cli.main import main\012sys.exit(main()) chat --tui`
      )
    ).toEqual({ agent: 'hermes', processName: 'hermes' })
    for (const notHermes of [
      'python3 -I -c import hermes_bootstrap_tests',
      'python3 tool.py -c "import hermes_bootstrap"',
      'python3 -m pytest -c x.ini -k "import hermes_bootstrap"'
    ]) {
      expect(recognizeAgentProcessFromCommandLine(notHermes)).toBeNull()
    }
    expect(recognizeAgentProcessFromCommandLine('python -m aider')).toEqual({
      agent: 'aider',
      processName: 'aider'
    })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`python C:\Users\dev\AppData\Roaming\Python\Python312\Scripts\aider.py`
      )
    ).toEqual({ agent: 'aider', processName: 'aider' })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\codex.cmd`
      )
    ).toEqual({ agent: 'codex', processName: 'codex' })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`
      )
    ).toEqual({ agent: 'codex', processName: 'codex' })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.mjs`
      )
    ).toEqual({ agent: 'gemini', processName: 'gemini' })
  })

  it.each([
    ['earendil-works', 'cli.js'],
    ['earendil-works', 'bundle/cli.js'],
    ['mariozechner', 'cli.js'],
    ['mariozechner', 'bundle/cli.js']
  ])('recognizes the @%s Pi npm entrypoint at dist/%s', (scope, entrypoint) => {
    const windowsEntrypoint = entrypoint.replace('/', '\\')
    const windowsPath = `C:\\Users\\Dev User\\AppData\\Roaming\\npm\\node_modules\\@${scope}\\pi-coding-agent\\dist\\${windowsEntrypoint}`
    for (const command of [
      `node /usr/local/lib/node_modules/@${scope}/pi-coding-agent/dist/${entrypoint}`,
      `node.exe ${windowsPath.replace('Dev User', 'dev')}`,
      String.raw`"C:\Program Files\nodejs\node.exe" "${windowsPath}"`
    ]) {
      expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
        agent: 'pi',
        processName: 'pi'
      })
    }
  })

  it.each([
    'node /tmp/dist/bundle/cli.js',
    'node /tmp/node_modules/@other/pi-coding-agent/dist/bundle/cli.js',
    'node /tmp/node_modules/@earendil-works/not-pi-coding-agent/dist/bundle/cli.js',
    'node /tmp/notnode_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    'node /tmp/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js.extra',
    'node /tmp/node_modules/@earendil-works/pi-coding-agent/dist/bundle/nested/cli.js',
    'node /tmp/server.js /tmp/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    'node --require /tmp/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /tmp/server.js',
    'node --eval "console.log(1)" /tmp/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
  ])('does not recognize a Pi entrypoint lookalike or argument: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
  })

  it("recognizes an older Claude Code's npm entrypoint, which a pnpm or yarn shim or npx runs", () => {
    const windowsPath = String.raw`C:\Users\dev\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js`
    for (const command of [
      'node /Users/dev/Library/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js',
      'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume abc',
      `node.exe ${windowsPath}`
    ]) {
      expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
        agent: 'claude',
        processName: 'claude'
      })
    }
  })

  it('leaves a print-mode run of that entrypoint unrecognized, as it does the native binary', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p "summarize"'
      )
    ).toBeNull()
  })

  it.each([
    'node /tmp/node_modules/@other/claude-code/cli.js',
    'node /tmp/node_modules/@anthropic-ai/claude-code/dist/cli.js',
    'node /tmp/server.js /tmp/node_modules/@anthropic-ai/claude-code/cli.js'
  ])('does not recognize a Claude Code entrypoint lookalike or argument: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
  })

  // Command lines captured from a live Windows Qwen Code 0.26.1 session (#17326).
  it.each([
    String.raw`"node"   "C:\Users\dev\AppData\Local\Temp\q\node_modules\.bin\\..\@qwen-code\qwen-code\cli-entry.js"`,
    String.raw`"node"   "C:\Users\dev\AppData\Roaming\npm\\node_modules\@qwen-code\qwen-code\cli-entry.js"`,
    String.raw`"C:\Program Files\nodejs\node.exe" --expose-gc C:\Users\dev\AppData\Roaming\npm\node_modules\@qwen-code\qwen-code\cli.js`,
    String.raw`"C:\Users\dev\AppData\Local\qwen-code\qwen-code\node\node.exe" "C:\Users\dev\AppData\Local\qwen-code\qwen-code\bin\..\lib\cli-entry.js"`,
    String.raw`C:\Users\dev\AppData\Local\qwen-code\qwen-code\node\node.exe --expose-gc C:\Users\dev\AppData\Local\qwen-code\qwen-code\lib\cli.js`,
    'node /usr/local/lib/node_modules/@qwen-code/qwen-code/cli.js'
  ])('recognizes a node-launched Qwen Code entrypoint: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
      agent: 'qwen-code',
      processName: 'qwen'
    })
  })

  it.each([
    'node /tmp/node_modules/@qwen-code/qwen-code/fzfWorker.js',
    'node /tmp/node_modules/@other/qwen-code/cli.js',
    'node /tmp/not-qwen-code/lib/cli.js'
  ])('does not recognize a Qwen Code entrypoint lookalike: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
  })

  it('does not recognize Prime Agent headless one-shot commands as interactive agents', () => {
    expect(recognizeAgentProcessFromCommandLine('prime-agent -p "summarize this diff"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('prime-agent --print "review this"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('prime-agent --resume abc123')).toEqual({
      agent: 'prime-agent',
      processName: 'prime-agent'
    })
    // Why: past `--` nothing is a flag, so this is the interactive pane Orca itself launches.
    expect(
      recognizeAgentProcessFromCommandLine('prime-agent -- "--print the release notes"')
    ).toEqual({ agent: 'prime-agent', processName: 'prime-agent' })
  })

  it('does not recognize Prime Agent non-interactive --mode runs as interactive agents', () => {
    for (const mode of ['json', 'rpc', 'acp', 'daemon']) {
      expect(recognizeAgentProcessFromCommandLine(`prime-agent --mode ${mode}`)).toBeNull()
    }
    // Why: `text` is the interactive TUI mode Orca hosts.
    expect(recognizeAgentProcessFromCommandLine('prime-agent --mode text')).toEqual({
      agent: 'prime-agent',
      processName: 'prime-agent'
    })
    // This CLI parses only --mode VALUE; joined --mode=json is ignored and remains interactive.
    expect(recognizeAgentProcessFromCommandLine('prime-agent --mode=json')).toEqual({
      agent: 'prime-agent',
      processName: 'prime-agent'
    })
    expect(recognizeAgentProcessFromCommandLine('prime-agent -- --mode rpc')).toEqual({
      agent: 'prime-agent',
      processName: 'prime-agent'
    })
  })

  it('recognizes only the agent subcommand of the generic Orca CLI', () => {
    expect(recognizeAgentProcessFromCommandLine('orca claude-teams')).toEqual({
      agent: 'claude-agent-teams',
      processName: 'orca'
    })
    expect(recognizeAgentProcessFromCommandLine('orca status')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('orca-dev terminal list')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('node /usr/local/bin/orca claude-teams')).toEqual({
      agent: 'claude-agent-teams',
      processName: 'orca'
    })
    expect(recognizeAgentProcessFromCommandLine('node /usr/local/bin/orca status')).toBeNull()
  })

  it('recognizes the versioned Cursor Node wrapper without accepting generic agent processes', () => {
    const cursorEntrypoint = String.raw`C:\Users\dev\AppData\Local\cursor-agent\versions\2026.07.09-a3815c0\index.js`

    expect(recognizeAgentProcessFromCommandLine(`node.exe ${cursorEntrypoint}`)).toEqual({
      agent: 'cursor',
      processName: 'cursor-agent'
    })
    expect(
      recognizeAgentProcessFromCommandLine(`node.exe ${cursorEntrypoint} worker-server`)
    ).toEqual({ agent: 'cursor', processName: 'cursor-agent' })
    expect(
      recognizeAgentProcessFromCommandLine(String.raw`node.exe C:\repo\cursor-agent\index.js`)
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(String.raw`C:\Users\dev\.grok\bin\agent.exe`)
    ).toBeNull()
  })

  it('does not classify prompt text as a wrapped agent command', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        'node /tmp/not-an-agent.js "compare opencode vs orca in Gemini CLI"'
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`node C:\tmp\not-an-agent.js`)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\repo\server.js --plugin C:\tmp\codex.js`
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`node C:\repo\codex.js`)).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`node C:\repo\gemini.mjs`)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\repo\node_modules\@example\pi-coding-agent\dist\cli.js`
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`python C:\repo\aider.py`)).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('python -m not_aider')).toBeNull()
  })

  it('does not recognize Muse headless exec runs as interactive agents', () => {
    expect(recognizeAgentProcessFromCommandLine("muse 'exec'")).toBeNull()
    for (const command of ['muse resume', 'muse -- resume', 'muse -- "exec the release notes"']) {
      expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
        agent: 'muse',
        processName: 'muse'
      })
    }
    expect(recognizeAgentProcessFromCommandLine('muse exec "summarize this diff"')).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        '/Users/dev/.local/bin/muse-bin-1.3.0-R3401.1 exec --session-id abc "hi"'
      )
    ).toBeNull()
    // Muse1.3.0 exec is headless; exec after flags/-- fails fast instead of hosting a TUI.
    expect(recognizeAgentProcessFromCommandLine('muse -- exec "summarize this diff"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('muse --yolo exec "hi"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('muse -- yolo')).toEqual({
      agent: 'muse',
      processName: 'muse'
    })
    // Why: subcommand dispatch is case-sensitive, so an uppercase prompt is the TUI.
    expect(recognizeAgentProcessFromCommandLine("muse 'EXEC'")).toEqual({
      agent: 'muse',
      processName: 'muse'
    })
  })
})
