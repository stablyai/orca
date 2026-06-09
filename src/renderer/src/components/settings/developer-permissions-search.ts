import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getDeveloperPermissionsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.developer.permissions.search.e92cb0896d',
      'Developer Permissions'
    ),
    description: translate(
      'auto.components.settings.developer.permissions.search.bc8ac95310',
      'macOS permissions for terminal-launched developer tools.'
    ),
    keywords: [
      translate('auto.components.settings.developer.permissions.search.a98aa11a9c', 'permissions'),
      translate('auto.components.settings.developer.permissions.search.2270ccff3f', 'privacy'),
      translate('auto.components.settings.developer.permissions.search.0c13b249e3', 'tcc'),
      translate('auto.components.settings.developer.permissions.search.6db4fca386', 'macos'),
      translate(
        'auto.components.settings.developer.permissions.search.4e225e7c56',
        'developer tools'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.developer.permissions.search.302c0c42f9',
      'Microphone and Camera'
    ),
    description: translate(
      'auto.components.settings.developer.permissions.search.6eca1636b7',
      'Allow voice, transcription, webcam, and media capture tools.'
    ),
    keywords: [
      translate('auto.components.settings.developer.permissions.search.ed7c12bdb4', 'microphone'),
      translate('auto.components.settings.developer.permissions.search.259b829b84', 'camera'),
      translate('auto.components.settings.developer.permissions.search.af122938a3', 'voice'),
      translate('auto.components.settings.developer.permissions.search.b192432ef0', 'audio'),
      translate('auto.components.settings.developer.permissions.search.a765112513', 'video'),
      translate('auto.components.settings.developer.permissions.search.f061f08b7b', 'sox'),
      translate('auto.components.settings.developer.permissions.search.1e6e27b202', 'ffmpeg'),
      translate('auto.components.settings.developer.permissions.search.00e954319e', 'whisper')
    ]
  },
  {
    title: translate(
      'auto.components.settings.developer.permissions.search.39bb49e662',
      'Screen Recording and Accessibility'
    ),
    description: translate(
      'auto.components.settings.developer.permissions.search.2e5d98ab56',
      'Allow screenshots, screen inspection, keystrokes, and window automation.'
    ),
    keywords: [
      translate(
        'auto.components.settings.developer.permissions.search.3cd51d18a1',
        'screen recording'
      ),
      translate(
        'auto.components.settings.developer.permissions.search.08f8039ca9',
        'accessibility'
      ),
      translate('auto.components.settings.developer.permissions.search.0a467b750e', 'screenshot'),
      translate('auto.components.settings.developer.permissions.search.5610022e1e', 'automation'),
      translate('auto.components.settings.developer.permissions.search.7f145a3984', 'window')
    ]
  },
  {
    title: translate(
      'auto.components.settings.developer.permissions.search.bbf543a3a1',
      'Full Disk Access'
    ),
    description: translate(
      'auto.components.settings.developer.permissions.search.05ab708ee5',
      'Open the macOS privacy pane for broad terminal file access.'
    ),
    keywords: [
      translate(
        'auto.components.settings.developer.permissions.search.c10e36cbd1',
        'full disk access'
      ),
      translate('auto.components.settings.developer.permissions.search.4438f81bfa', 'documents'),
      translate('auto.components.settings.developer.permissions.search.a0c19119fb', 'downloads'),
      translate('auto.components.settings.developer.permissions.search.ce07159ff5', 'desktop'),
      translate('auto.components.settings.developer.permissions.search.3e0131e45d', 'icloud')
    ]
  },
  {
    title: translate(
      'auto.components.settings.developer.permissions.search.3363889768',
      'Local Network, USB, and Bluetooth'
    ),
    description: translate(
      'auto.components.settings.developer.permissions.search.acad3d4743',
      'Allow device and local-network tools used from terminal sessions.'
    ),
    keywords: [
      translate(
        'auto.components.settings.developer.permissions.search.fa3239cd42',
        'local network'
      ),
      translate('auto.components.settings.developer.permissions.search.c4a4a02ea4', 'usb'),
      translate('auto.components.settings.developer.permissions.search.e3fbc48083', 'bluetooth'),
      translate('auto.components.settings.developer.permissions.search.78a10b826f', 'bonjour'),
      translate('auto.components.settings.developer.permissions.search.11653d3f42', 'mdns'),
      translate('auto.components.settings.developer.permissions.search.6c82846f66', 'device')
    ]
  }
])
