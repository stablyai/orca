export const MOBILE_E2EE_LEGACY_FIXTURE = {
  serverSecretKey: new Uint8Array(32).fill(1),
  clientSecretKey: new Uint8Array(32).fill(2),
  serverPublicKeyB64: 'pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=',
  clientPublicKeyB64: 'zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=',
  sharedKeyHex: '18a99320f3488fa18a04239715d8ee738065e65c3d4b2898522d6c3d4ead588c',
  helloText: '{"type":"e2ee_hello","publicKeyB64":"zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk="}',
  readyText: '{"type":"e2ee_ready"}',
  authPlaintext: '{"type":"e2ee_auth","deviceToken":"legacy-token"}',
  authFrameB64:
    'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGTxV8uZ+DG8yRMwrsAYDOGAHUylsq9vpyPLHIz5lrt+vb8AFA6SXELR72fhVZpQiC5tDhn3RUuo0CNefKVy/njNg=',
  binaryPlaintext: new Uint8Array([0, 1, 2, 127, 128, 255]),
  binaryFrameHex:
    '060606060606060606060606060606060606060606060606200be03dc6f8c733e1b85657d9a52dfe7af7bc5dda6c'
} as const
