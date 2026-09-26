import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPdfScalePreferenceKey,
  PDF_SCALE_PREFERENCES_STORAGE_KEY,
  readPdfScalePreference,
  writePdfScalePreference
} from './pdf-scale-preference-storage'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PDF scale preference storage', () => {
  it('keeps identical paths isolated by worktree and remote owner', () => {
    const localKey = buildPdfScalePreferenceKey({ worktreeId: 'worktree-a', filePath: '/doc.pdf' })
    const runtimeKey = buildPdfScalePreferenceKey({
      worktreeId: 'worktree-a',
      runtimeEnvironmentId: 'runtime-b',
      filePath: '/doc.pdf'
    })
    const sshKey = buildPdfScalePreferenceKey({
      worktreeId: 'worktree-a',
      externalSshTargetId: 'ssh-c',
      filePath: '/doc.pdf'
    })

    expect(new Set([localKey, runtimeKey, sshKey]).size).toBe(3)
  })

  it('round-trips a preference by file path', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)

    writePdfScalePreference('/repo/report.pdf', 1.75)

    expect(readPdfScalePreference('/repo/report.pdf')).toBe(1.75)
    expect(readPdfScalePreference('/repo/other.pdf')).toBeNull()
  })

  it('persists fit-to-width resets and keeps files isolated', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)

    writePdfScalePreference('/repo/report.pdf', 2)
    writePdfScalePreference('/repo/other.pdf', 'page-width')

    expect(readPdfScalePreference('/repo/report.pdf')).toBe(2)
    expect(readPdfScalePreference('/repo/other.pdf')).toBe('page-width')
  })

  it('ignores malformed stored values', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)
    storage.setItem(
      PDF_SCALE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ '/repo/report.pdf': { scale: 2 } })
    )

    expect(readPdfScalePreference('/repo/report.pdf')).toBeNull()
  })

  it('evicts the oldest entries after reaching the storage bound', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)

    for (let index = 0; index < 101; index += 1) {
      writePdfScalePreference(`/repo/report-${index}.pdf`, index)
    }

    expect(readPdfScalePreference('/repo/report-0.pdf')).toBeNull()
    expect(readPdfScalePreference('/repo/report-100.pdf')).toBe(100)
  })

  it('ignores storage write failures', () => {
    const storage = createMemoryStorage()
    storage.setItem = () => {
      throw new Error('storage unavailable')
    }
    vi.stubGlobal('localStorage', storage)

    expect(() => writePdfScalePreference('/repo/report.pdf', 1.5)).not.toThrow()
  })
})

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}
