import type { GlobalSettings } from '../global-settings-types'
import { MACHINE_KEY_TABLE } from './machine-settings-keys'
import { PORTABLE_KEY_SPECS } from './portable-settings-keys'
import { PRIVATE_KEY_TABLE } from './private-settings-keys'

/** portable: same meaning on any machine; machine: host-bound or internal; private: credentials, accounts, grants. */
export type SettingsKeyPortability = 'portable' | 'machine' | 'private'

type PortableKey = keyof typeof PORTABLE_KEY_SPECS
type MachineKey = keyof typeof MACHINE_KEY_TABLE
type PrivateKey = keyof typeof PRIVATE_KEY_TABLE

// A key listed in two tables would be silently overridden by the spread below.
const tablesAreDisjoint: [
  Extract<PortableKey, MachineKey>,
  Extract<PortableKey, PrivateKey>,
  Extract<MachineKey, PrivateKey>
] extends [never, never, never]
  ? true
  : never = true
void tablesAreDisjoint

type PortableKeyClassification = { readonly [K in keyof typeof PORTABLE_KEY_SPECS]: 'portable' }

function classifyPortableKeys(): PortableKeyClassification {
  const entries = Object.keys(PORTABLE_KEY_SPECS).map((key) => [key, 'portable'] as const)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: entries are built from the keys of PORTABLE_KEY_SPECS, so the result has exactly its keys.
  return Object.fromEntries(entries) as PortableKeyClassification
}

// Each table rejects unknown keys; the merge rejects unclassified GlobalSettings keys.
export const SETTINGS_KEY_PORTABILITY = {
  ...classifyPortableKeys(),
  ...MACHINE_KEY_TABLE,
  ...PRIVATE_KEY_TABLE
} satisfies Record<keyof GlobalSettings, SettingsKeyPortability>

function isSettingsKey(key: string): key is keyof GlobalSettings {
  return key in SETTINGS_KEY_PORTABILITY
}

export const PORTABLE_SETTINGS_KEYS: readonly (keyof GlobalSettings)[] =
  Object.keys(PORTABLE_KEY_SPECS).filter(isSettingsKey)
