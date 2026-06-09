import type { SettingsSearchEntry } from './settings-search'

export const MOBILE_EMULATOR_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Mobile Emulator',
    description: 'Configure mobile emulator support for Orca and coding agents.',
    keywords: [
      'mobile emulator',
      'ios simulator',
      'simulator',
      'emulator',
      'iphone',
      'ipad',
      'xcode',
      'serve-sim',
      'orca cli',
      'orca emulator',
      'emulator skill',
      'default device',
      'agent emulator'
    ]
  },
  {
    title: 'Default Emulator Device',
    description: 'Choose which emulator device Orca opens by default.',
    keywords: ['default simulator', 'default iphone', 'default ipad', 'udid', 'device']
  },
  {
    title: 'Emulator Availability',
    description: 'Check whether Xcode, simctl, serve-sim, and emulator devices are ready.',
    keywords: ['availability', 'xcrun', 'simctl', 'xcode command line tools', 'runtime']
  },
  {
    title: 'Agent CLI Control',
    description: 'Use Orca CLI commands to list, attach, tap, and type into a mobile emulator.',
    keywords: ['agent cli', 'emulator tap', 'emulator attach', 'emulator type', 'mobile skill']
  }
]
