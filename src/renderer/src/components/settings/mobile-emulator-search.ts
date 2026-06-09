import { translate } from '@/i18n/i18n'
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
      translate('auto.components.settings.mobile.emulator.search.25159de808', 'mobile emulator'),
      translate('auto.components.settings.mobile.emulator.search.c5eca29310', 'ios simulator'),
      translate('auto.components.settings.mobile.emulator.search.2d67f708ce', 'simulator'),
      translate('auto.components.settings.mobile.emulator.search.6b6407dc1f', 'emulator'),
      translate('auto.components.settings.mobile.emulator.search.49727355a3', 'iphone'),
      translate('auto.components.settings.mobile.emulator.search.bec7231663', 'ipad'),
      translate('auto.components.settings.mobile.emulator.search.7c5a8a2bee', 'xcode'),
      translate('auto.components.settings.mobile.emulator.search.84e5706975', 'serve-sim'),
      translate('auto.components.settings.mobile.emulator.search.d4b7833894', 'orca cli'),
      translate('auto.components.settings.mobile.emulator.search.9353854ff3', 'orca emulator'),
      translate('auto.components.settings.mobile.emulator.search.ac0a985873', 'emulator skill'),
      translate('auto.components.settings.mobile.emulator.search.1ad6fb6230', 'default device'),
      translate('auto.components.settings.mobile.emulator.search.b8ddd13195', 'agent emulator')
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
      translate('auto.components.settings.mobile.emulator.search.ab4814f3c5', 'default simulator'),
      translate('auto.components.settings.mobile.emulator.search.1dc8c52ffa', 'default iphone'),
      translate('auto.components.settings.mobile.emulator.search.ec3c4043fd', 'default ipad'),
      translate('auto.components.settings.mobile.emulator.search.25d7bfbcd4', 'udid'),
      translate('auto.components.settings.mobile.emulator.search.04c5f5d901', 'device')
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
      translate('auto.components.settings.mobile.emulator.search.42bfab45d8', 'availability'),
      translate('auto.components.settings.mobile.emulator.search.3211e7acf9', 'xcrun'),
      translate('auto.components.settings.mobile.emulator.search.7650063d17', 'simctl'),
      translate(
        'auto.components.settings.mobile.emulator.search.27397fe8e9',
        'xcode command line tools'
      ),
      translate('auto.components.settings.mobile.emulator.search.8ef0f08d36', 'runtime')
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
      translate('auto.components.settings.mobile.emulator.search.f8b871d655', 'agent cli'),
      translate('auto.components.settings.mobile.emulator.search.6f728f1456', 'emulator tap'),
      translate('auto.components.settings.mobile.emulator.search.64494f03c3', 'emulator attach'),
      translate('auto.components.settings.mobile.emulator.search.bbe4267416', 'emulator type'),
      translate('auto.components.settings.mobile.emulator.search.2bb2e09225', 'mobile skill')
    ]
  }
])
