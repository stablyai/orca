import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getMobileEmulatorSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.mobile.emulator.search.cdd3c31918',
      'Mobile Emulator'
    ),
    description: translate(
      'auto.components.settings.mobile.emulator.search.9595354cff',
      'Configure mobile emulator support for Orca and coding agents.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.25159de808',
        'mobile emulator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.c5eca29310',
        'ios simulator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.2d67f708ce',
        'simulator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.6b6407dc1f',
        'emulator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.49727355a3',
        'iphone'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.bec7231663',
        'ipad'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.7c5a8a2bee',
        'xcode'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.84e5706975',
        'serve-sim'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.d4b7833894',
        'orca cli'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.9353854ff3',
        'orca emulator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.ac0a985873',
        'emulator skill'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.1ad6fb6230',
        'default device'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.b8ddd13195',
        'agent emulator'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.mobile.emulator.search.54184cb9c5',
      'Default Emulator Device'
    ),
    description: translate(
      'auto.components.settings.mobile.emulator.search.2348045036',
      'Choose which emulator device Orca opens by default.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.ab4814f3c5',
        'default simulator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.1dc8c52ffa',
        'default iphone'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.ec3c4043fd',
        'default ipad'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.25d7bfbcd4',
        'udid'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.04c5f5d901',
        'device'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.mobile.emulator.search.0b95dfd5b3',
      'Emulator Availability'
    ),
    description: translate(
      'auto.components.settings.mobile.emulator.search.ea1f51b980',
      'Check whether Xcode, simctl, serve-sim, and emulator devices are ready.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.42bfab45d8',
        'availability'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.3211e7acf9',
        'xcrun'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.7650063d17',
        'simctl'
      ),
      translate(
        'auto.components.settings.mobile.emulator.search.27397fe8e9',
        'xcode command line tools'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.8ef0f08d36',
        'runtime'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.mobile.emulator.search.ea3eac39bb',
      'Agent CLI Control'
    ),
    description: translate(
      'auto.components.settings.mobile.emulator.search.2e0b45b2ba',
      'Use Orca CLI commands to list, attach, tap, and type into a mobile emulator.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.f8b871d655',
        'agent cli'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.6f728f1456',
        'emulator tap'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.64494f03c3',
        'emulator attach'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.bbe4267416',
        'emulator type'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.emulator.search.2bb2e09225',
        'mobile skill'
      )
    ]
  }
])
