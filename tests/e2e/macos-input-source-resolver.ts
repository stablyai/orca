import { execFileSync } from 'node:child_process'

/**
 * Resolves a macOS input source from a list of candidate bundle IDs.
 *
 * Why candidates rather than one constant: Apple ships the same input method under different
 * bundle IDs across macOS versions and localisations — Cangjie exists as BOTH
 * `com.apple.inputmethod.TCIM.Cangjie` and `com.apple.inputmethod.TYIM.Cangjie` on a single
 * host, and Simple Telex moved under a `VietnameseIM.` prefix. Hardcoding one ID makes a spec
 * fail on hosts where the other is installed, and the failure reads like an operator error
 * ("you didn't select the right source") rather than a stale constant.
 */

const LIST_INSTALLED_SWIFT = `
import Foundation
import Carbon
if let list = TISCreateInputSourceList(nil, true)?.takeRetainedValue() as? [TISInputSource] {
  for s in list {
    guard let idPtr = TISGetInputSourceProperty(s, kTISPropertyInputSourceID) else { continue }
    let id = Unmanaged<CFString>.fromOpaque(idPtr).takeUnretainedValue() as String
    var selectable = false
    if let p = TISGetInputSourceProperty(s, kTISPropertyInputSourceIsSelectCapable) {
      selectable = CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(p).takeUnretainedValue())
    }
    var enabled = false
    if let p = TISGetInputSourceProperty(s, kTISPropertyInputSourceIsEnabled) {
      enabled = CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(p).takeUnretainedValue())
    }
    print("\\(id)|\\(enabled)|\\(selectable)")
  }
}
`

export type InstalledInputSource = { id: string; enabled: boolean; selectable: boolean }

export function listInstalledInputSources(): InstalledInputSource[] {
  const output = execFileSync('swift', ['-'], { input: LIST_INSTALLED_SWIFT, encoding: 'utf8' })
  return output
    .split('\n')
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [id, enabled, selectable] = line.split('|')
      return { id, enabled: enabled === 'true', selectable: selectable === 'true' }
    })
}

/**
 * Returns the first candidate that is installed AND selectable, or throws naming every candidate
 * and what TIS actually reported. A spec that cannot establish its own input-source precondition
 * must abort — proceeding captures the wrong source and the run looks valid.
 */
export function resolveInputSourceId(label: string, candidates: readonly string[]): string {
  const installed = listInstalledInputSources()
  const byId = new Map(installed.map((source) => [source.id, source]))

  for (const candidate of candidates) {
    if (byId.get(candidate)?.selectable) {
      return candidate
    }
  }

  const present = candidates
    .map((candidate) => {
      const found = byId.get(candidate)
      return found
        ? `  ${candidate} — installed but selectable=${found.selectable}, enabled=${found.enabled}`
        : `  ${candidate} — NOT INSTALLED`
    })
    .join('\n')
  // Surface near-matches so a renamed bundle ID is obvious rather than looking like a missing IME.
  const stem = label.toLowerCase()
  const near = installed
    .filter((source) => source.id.toLowerCase().includes(stem))
    .map((source) => `  ${source.id} (enabled=${source.enabled}, selectable=${source.selectable})`)
  const hint =
    near.length > 0
      ? `TIS reports these ${label}-like sources instead:\n${near.join('\n')}`
      : `TIS reports no ${label}-like source at all — enable it in System Settings > Keyboard.`
  throw new Error(`No selectable input source for ${label}. Candidates:\n${present}\n${hint}`)
}
