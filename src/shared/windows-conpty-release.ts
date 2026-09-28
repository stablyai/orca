/** Microsoft Terminal v1.23.12811.0 assets, identical to the qualified ConPTY provider. */
export const WINDOWS_CONPTY_VERSION = '1.23.251008001'
export const WINDOWS_CONPTY_ARCHIVE = {
  url: 'https://github.com/microsoft/terminal/releases/download/v1.23.12811.0/Microsoft.Windows.Console.ConPTY.1.23.251008001.nupkg',
  sha256: 'f7e142a99f5dfee573ace98676b3c7c2fcdb870bc90b238086a4d80a36fcf099',
  nuspecSha256: '845e41cf307cf71a59c25a7555fa05a91087930048f8a7918dc614f1255241af'
} as const

export const WINDOWS_CONPTY_FILES = {
  x64: {
    'conpty.dll': '7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed',
    'OpenConsole.exe': 'd1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc'
  },
  arm64: {
    'conpty.dll': 'b6cca5f1081111f59e5255eec043d924ebd11a86d09986c0d121b680540b3380',
    'OpenConsole.exe': 'b7763ba27e80d5e84f9e60d1368ec2ddb25dfd10283336c0c9f3f252d35cb2f8'
  }
} as const
