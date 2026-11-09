import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress } from './pty-startup-ingress'
import type { PtyIngressEmission } from './pty-startup-ingress-contract'

const SHELL_GROUP = 100
const COMMAND_GROUP = 200
const QUERY = '\x1b]11;?\x07'
const REPLY = '\x1b]11;rgb:0000/0000/0000\x1b\\'
const DA1 = '\x1b[c'
const PROMPT = '\x1b]133;D;0\x07\x1b]133;A\x07$ '
const COMMAND_START = '\x1b]133;C\x07'

function createHarness() {
  const writes: string[] = []
  const emissions: PtyIngressEmission[] = []
  let group: number | null = SHELL_GROUP
  const groupReads = { count: 0 }
  const ingress = new PtyStartupIngress({
    ownerBackend: 'posix-pty',
    resolveHostColors: () => ({ foreground: '#ffffff', background: '#000000' }),
    readForegroundGroup: () => {
      groupReads.count += 1
      return group
    },
    write: (data) => writes.push(data),
    onEmission: (emission) => emissions.push(emission)
  })
  const visible = (): string => emissions.map((emission) => emission.data).join('')
  const setGroup = (next: number | null): void => {
    group = next
  }
  // The shell prints its prompt, then runs a command in its own process group.
  const runCommand = (commandGroup = COMMAND_GROUP): void => {
    ingress.accept(`${PROMPT}${COMMAND_START}`)
    group = commandGroup
  }
  return { ingress, writes, emissions, visible, setGroup, runCommand, groupReads }
}

describe('PTY owner colour replies after the asker exits', () => {
  afterEach(() => vi.useRealTimers())

  it('drops the reply when the shell finishes the command right after it asked', () => {
    // `/usr/bin/printf '\e]11;?\a'` exits before bash prints its prompt; the reply would be typed into bash (#16633).
    vi.useFakeTimers()
    const { ingress, writes, visible, setGroup, runCommand } = createHarness()
    runCommand()
    ingress.accept(QUERY)
    setGroup(SHELL_GROUP)
    ingress.accept(PROMPT)
    vi.runAllTimers()

    expect(writes).toEqual([])
    expect(visible()).toBe(`${PROMPT}${COMMAND_START}${PROMPT}`)
  })

  it('without a foreground group (ConPTY), drops on the finish marker and answers a live asker after the wait', () => {
    vi.useFakeTimers()
    const { ingress, writes, setGroup, runCommand } = createHarness()
    runCommand()
    setGroup(null)
    ingress.accept(`${QUERY}${PROMPT}`)
    ingress.accept(COMMAND_START)
    ingress.accept(QUERY)
    ingress.accept(PROMPT)
    vi.runAllTimers()
    expect(writes).toEqual([])

    ingress.accept(COMMAND_START)
    ingress.accept(QUERY)
    vi.advanceTimersByTime(20)
    expect(writes).toEqual([REPLY])
  })

  it('drops the reply when the next command of the line has taken the terminal', () => {
    // `printf …; cat`: bash hands the terminal to cat before it prints any prompt.
    vi.useFakeTimers()
    const { ingress, writes, setGroup, runCommand } = createHarness()
    runCommand()
    ingress.accept(QUERY)
    setGroup(COMMAND_GROUP + 1)
    vi.advanceTimersByTime(20)

    expect(writes).toEqual([])
  })

  it('answers a live command after a short wait, keeping a DA1 sentinel behind the reply', () => {
    vi.useFakeTimers()
    const { ingress, writes, visible, runCommand } = createHarness()
    runCommand()
    ingress.accept(`${QUERY}${DA1}`)
    expect(writes).toEqual([])
    expect(visible()).toBe(`${PROMPT}${COMMAND_START}`)

    vi.advanceTimersByTime(20)
    expect(writes).toEqual([REPLY])
    expect(visible()).toBe(`${PROMPT}${COMMAND_START}${DA1}`)

    // Every later query waits too: a live asker can still exit right after its next query.
    ingress.accept(QUERY)
    expect(writes).toEqual([REPLY])
    vi.advanceTimersByTime(20)
    expect(writes).toEqual([REPLY, REPLY])
  })

  it('answers a builtin or command substitution in the shell group once no prompt follows', () => {
    vi.useFakeTimers()
    const { ingress, writes, runCommand } = createHarness()
    runCommand(SHELL_GROUP)
    ingress.accept(QUERY)
    vi.advanceTimersByTime(20)

    expect(writes).toEqual([REPLY])
  })

  it('forgets a live shell-group asker once its command ends', () => {
    vi.useFakeTimers()
    const { ingress, writes, runCommand } = createHarness()
    runCommand(SHELL_GROUP)
    ingress.accept(QUERY)
    vi.advanceTimersByTime(20)
    runCommand(SHELL_GROUP)
    ingress.accept(QUERY)
    ingress.accept(PROMPT)
    vi.runAllTimers()

    expect(writes).toEqual([REPLY])
  })

  it('forgets a live group once a later asker in the command is proven gone', () => {
    vi.useFakeTimers()
    const { ingress, writes, setGroup, runCommand } = createHarness()
    runCommand()
    ingress.accept(QUERY)
    vi.advanceTimersByTime(20)
    setGroup(COMMAND_GROUP + 1)
    ingress.accept(QUERY)
    setGroup(COMMAND_GROUP)
    vi.advanceTimersByTime(20)
    ingress.accept(QUERY)
    ingress.accept(PROMPT)
    vi.runAllTimers()

    expect(writes).toEqual([REPLY])
  })

  it('sees a finish marker split across reads during the wait', () => {
    vi.useFakeTimers()
    const { ingress, writes, runCommand } = createHarness()
    runCommand(SHELL_GROUP)
    ingress.accept(`${QUERY}\x1b]133;`)
    ingress.accept('D;0\x07')
    vi.runAllTimers()

    expect(writes).toEqual([])
  })

  it('keeps a live asker held across a snapshot barrier, which never answers early', () => {
    vi.useFakeTimers()
    const { ingress, writes, visible, runCommand } = createHarness()
    runCommand(SHELL_GROUP)
    ingress.accept(`${QUERY}after`)
    ingress.snapshotBarrier()
    expect(writes).toEqual([])
    ingress.accept(PROMPT)

    expect(writes).toEqual([])
    expect(visible()).toBe(`${PROMPT}${COMMAND_START}after${PROMPT}`)
  })

  it('keeps a torn echo behind a held query across a snapshot barrier', () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions, runCommand } = createHarness()
    ingress.accept(QUERY)
    runCommand()
    // A cooked reader echoes the earlier reply (`^[]11;…`) right after the next query.
    ingress.accept(`${QUERY}^[]11;rgb`)
    ingress.snapshotBarrier()
    vi.advanceTimersByTime(20)

    expect(writes).toEqual([REPLY, REPLY])
    // Emitted ranges stay contiguous: the held echo never overtakes the held query.
    for (const [index, emission] of emissions.entries()) {
      expect(emission.rawStartSeq).toBe(index === 0 ? 0 : emissions[index - 1]?.rawEndSeq)
    }
  })

  it("drops a gone asker's later queries along with the first", () => {
    vi.useFakeTimers()
    const { ingress, writes, setGroup, runCommand } = createHarness()
    runCommand()
    ingress.accept(QUERY)
    ingress.accept(QUERY)
    setGroup(COMMAND_GROUP + 1)
    ingress.accept('next program output')
    vi.runAllTimers()

    expect(writes).toEqual([])
  })

  it('judges a query completed after an earlier verdict afresh', () => {
    vi.useFakeTimers()
    const { ingress, writes, runCommand } = createHarness()
    runCommand()
    ingress.accept(QUERY)
    ingress.accept('\x1b]11;?')
    vi.advanceTimersByTime(20)
    expect(writes).toEqual([REPLY])
    ingress.accept(`\x07${PROMPT}`)
    vi.runAllTimers()

    expect(writes).toEqual([REPLY])
  })

  it('answers at once at the prompt', () => {
    const { ingress, writes } = createHarness()
    ingress.accept(QUERY)
    ingress.accept(PROMPT)
    ingress.accept(QUERY)

    expect(writes).toEqual([REPLY, REPLY])
  })

  it('keeps watching a command whose app closes its own prompt zone (B C D;0, #10923)', () => {
    vi.useFakeTimers()
    const { ingress, writes, setGroup, runCommand } = createHarness()
    runCommand()
    ingress.accept(`\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07${QUERY}`)
    setGroup(SHELL_GROUP)
    ingress.accept(PROMPT)
    vi.runAllTimers()

    expect(writes).toEqual([])
  })

  it('tracks a long command marker torn across reads, and ignores one cut short by a bare ESC', () => {
    vi.useFakeTimers()
    const { ingress, writes } = createHarness()
    ingress.accept(PROMPT)
    ingress.accept(`\x1b]133;C;cmdline_url=${'x'.repeat(400)}`)
    ingress.accept('\x07')
    ingress.accept(QUERY)
    ingress.accept(PROMPT)
    vi.runAllTimers()
    expect(writes).toEqual([])

    ingress.accept('\x1b]133;C\x1b[31m')
    ingress.accept(QUERY)
    expect(writes).toEqual([REPLY])
  })
})
