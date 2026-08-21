import { afterEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  decideSshReattachPaintSource,
  memoizeSshReattachModelSnapshotProbe,
  resolveSshReattachModelSnapshotWithTimeout,
  shouldFetchSshReattachModelSnapshot
} from './ssh-reattach-model-restore'

// Why built, not literal: a hardcoded id would silently stop parsing as SSH if the
// prefix/separator changed, turning these positive cases into fallback expectations.
const SSH_PTY_ID = toAppSshPtyId('conn-1', 'relay-pty-1')
const LOCAL_PTY_ID = 'repo::/worktree@@session-1'

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveSshReattachModelSnapshotWithTimeout', () => {
  it('degrades a stalled snapshot probe to null', async () => {
    vi.useFakeTimers()
    const pending = new Promise<string>(() => {})
    const resolved = resolveSshReattachModelSnapshotWithTimeout(pending, 25)

    await vi.advanceTimersByTimeAsync(25)
    await expect(resolved).resolves.toBeNull()
  })

  it('passes through a prompt snapshot and degrades rejection to null', async () => {
    await expect(
      resolveSshReattachModelSnapshotWithTimeout(Promise.resolve('snapshot'), 25)
    ).resolves.toBe('snapshot')
    await expect(
      resolveSshReattachModelSnapshotWithTimeout(Promise.reject(new Error('unavailable')), 25)
    ).resolves.toBeNull()
  })
})

describe('shouldFetchSshReattachModelSnapshot', () => {
  it('fetches only for SSH ptys with SSH parking enabled', () => {
    expect(
      shouldFetchSshReattachModelSnapshot({ ptyId: SSH_PTY_ID, sshParkingEnabled: true })
    ).toBe(true)
    expect(
      shouldFetchSshReattachModelSnapshot({ ptyId: SSH_PTY_ID, sshParkingEnabled: false })
    ).toBe(false)
    expect(
      shouldFetchSshReattachModelSnapshot({ ptyId: LOCAL_PTY_ID, sshParkingEnabled: true })
    ).toBe(false)
  })
})

describe('memoizeSshReattachModelSnapshotProbe', () => {
  it('remembers a null prefetch so the payload task never probes twice', async () => {
    const probe = vi.fn().mockResolvedValue(null)
    const fetchSnapshot = memoizeSshReattachModelSnapshotProbe(probe)

    await expect(fetchSnapshot()).resolves.toBeNull()
    await expect(fetchSnapshot()).resolves.toBeNull()

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('returns the same resolved snapshot without re-probing', async () => {
    const probe = vi.fn().mockResolvedValue({ data: 'screen' })
    const fetchSnapshot = memoizeSshReattachModelSnapshotProbe(probe)

    const first = await fetchSnapshot()
    const second = await fetchSnapshot()

    expect(first).toBe(second)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent callers onto one probe', async () => {
    let resolveProbe: (value: string | null) => void = () => {}
    const probe = vi.fn(() => new Promise<string | null>((resolve) => (resolveProbe = resolve)))
    const fetchSnapshot = memoizeSshReattachModelSnapshotProbe(probe)

    const first = fetchSnapshot()
    const second = fetchSnapshot()
    resolveProbe(null)

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('decideSshReattachPaintSource', () => {
  const headless = { data: 'screen', source: 'headless' as const }

  it('paints from the main model only for a non-empty headless snapshot', () => {
    expect(
      decideSshReattachPaintSource({
        ptyId: SSH_PTY_ID,
        sshParkingEnabled: true,
        snapshot: headless
      })
    ).toBe('main-model-snapshot')
  })

  it('degrades to relay replay on null, renderer-sourced, sourceless, or empty snapshots', () => {
    for (const snapshot of [
      null,
      { data: 'screen', source: 'renderer' as const },
      { data: 'screen' },
      { data: '', source: 'headless' as const },
      { data: '', scrollbackAnsi: '', pendingEscapeTailAnsi: '', source: 'headless' as const }
    ]) {
      expect(
        decideSshReattachPaintSource({ ptyId: SSH_PTY_ID, sshParkingEnabled: true, snapshot })
      ).toBe('relay-replay')
    }
  })

  it('judges emptiness on the composed content, not the screen frame alone', () => {
    // Why: an alt-screen model snapshot can hold all content in scrollbackAnsi
    // with an empty screen.
    expect(
      decideSshReattachPaintSource({
        ptyId: SSH_PTY_ID,
        sshParkingEnabled: true,
        snapshot: { data: '', scrollbackAnsi: 'history', source: 'headless' as const }
      })
    ).toBe('main-model-snapshot')
  })

  it('treats a dangling escape tail alone as unpaintable content', () => {
    // Why: an incomplete escape sequence renders nothing, so painting it would
    // blank the pane over a relay replay that still holds the session.
    expect(
      decideSshReattachPaintSource({
        ptyId: SSH_PTY_ID,
        sshParkingEnabled: true,
        snapshot: { data: '', pendingEscapeTailAnsi: '\x1b[', source: 'headless' as const }
      })
    ).toBe('relay-replay')
  })

  it('never upgrades when the kill switch is off or the pty is not SSH', () => {
    expect(
      decideSshReattachPaintSource({
        ptyId: SSH_PTY_ID,
        sshParkingEnabled: false,
        snapshot: headless
      })
    ).toBe('relay-replay')
    expect(
      decideSshReattachPaintSource({
        ptyId: LOCAL_PTY_ID,
        sshParkingEnabled: true,
        snapshot: headless
      })
    ).toBe('relay-replay')
  })
})
