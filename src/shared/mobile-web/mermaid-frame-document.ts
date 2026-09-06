export const MOBILE_WEB_MERMAID_FRAME_PATH = 'mermaid-frame.html'
export const MOBILE_WEB_MERMAID_FRAME_INIT_CHANNEL = 'orca-mobile-mermaid-init'
export const MOBILE_WEB_MERMAID_FRAME_MESSAGE_CHANNEL = 'orca-mobile-mermaid'
export const MOBILE_WEB_MERMAID_FRAME_ENGINE_CHANNEL = 'orca-mobile-mermaid-engine'
export const MOBILE_WEB_MERMAID_MAX_SOURCE_CHARACTERS = 128 * 1024
export const MOBILE_WEB_MERMAID_ENGINE_CHUNK_CHARACTERS = 32 * 1024
export const MOBILE_WEB_MERMAID_MAX_ENGINE_CHARACTERS = 4 * 1024 * 1024

export const MOBILE_WEB_MERMAID_FRAME_SCRIPT = String.raw`(function () {
  var frameToken = '';
  var diagramSource = '';
  var engineLength = 0;
  var engineChunkCount = 0;

  function hasExactKeys(value, expected) {
    return Object.keys(value).sort().join(',') === expected;
  }

  function post(type, height) {
    var message = { channel: '${MOBILE_WEB_MERMAID_FRAME_MESSAGE_CHANNEL}', type: type, token: frameToken };
    if (height) message.height = height;
    var serialized = JSON.stringify(message);
    if (window.parent !== window) window.parent.postMessage(serialized, '*');
    else if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(serialized);
  }

  function decodeUtf8(encoded) {
    var binary = atob(encoded);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  async function loadEngine(encodedEngine, useBlob) {
    if (typeof DecompressionStream === 'undefined') throw new Error('gzip unavailable');
    var binary = atob(encodedEngine);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    var engine = await new Response(stream).text();
    var script = document.createElement('script');
    if (!useBlob) {
      script.textContent = engine;
      document.head.appendChild(script);
      return;
    }
    var scriptUrl = URL.createObjectURL(new Blob([engine], { type: 'text/javascript' }));
    try {
      await new Promise(function (resolve, reject) {
        script.onload = resolve;
        script.onerror = reject;
        script.src = scriptUrl;
        document.head.appendChild(script);
      });
    } finally {
      URL.revokeObjectURL(scriptUrl);
    }
  }

  async function render(encodedEngine, useBlob) {
    await loadEngine(encodedEngine, useBlob);
    if (diagramSource.length > ${MOBILE_WEB_MERMAID_MAX_SOURCE_CHARACTERS}) {
      throw new Error('diagram source too large');
    }
    var api = window.OrcaMermaid;
    var theme = getComputedStyle(document.documentElement);
    api.mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      darkMode: true,
      htmlLabels: false,
      themeVariables: {
        background: theme.getPropertyValue('--diagram-background'),
        primaryColor: theme.getPropertyValue('--diagram-primary'),
        primaryTextColor: theme.getPropertyValue('--diagram-text'),
        lineColor: theme.getPropertyValue('--diagram-line'),
        textColor: theme.getPropertyValue('--diagram-text')
      }
    });
    var result = await api.mermaid.render('orca-mermaid-diagram', diagramSource);
    var clean = api.sanitize(result.svg, {
      USE_PROFILES: { svg: true },
      FORBID_TAGS: ['a', 'foreignObject', 'script']
    });
    var container = document.getElementById('c');
    container.innerHTML = clean;
    var height = Math.ceil(container.scrollHeight);
    post('rendered', height > 0 && height <= 10000 ? height : 120);
  }

  function run(encodedEngine, useBlob) {
    render(encodedEngine, useBlob).catch(function () {
      post('error');
    });
  }

  function receiveEngine(event) {
    var message = event.data;
    if (
      event.source !== parent ||
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !hasExactKeys(message, 'channel,chunk,chunkCount,chunkIndex,token') ||
      message.channel !== '${MOBILE_WEB_MERMAID_FRAME_ENGINE_CHANNEL}' ||
      message.token !== frameToken ||
      !Number.isSafeInteger(message.chunkIndex) ||
      message.chunkIndex < 0 ||
      message.chunkIndex >= engineChunkCount ||
      message.chunkCount !== engineChunkCount ||
      typeof message.chunk !== 'string'
    ) return;
    var expectedLength = message.chunkIndex === engineChunkCount - 1
      ? engineLength - ${MOBILE_WEB_MERMAID_ENGINE_CHUNK_CHARACTERS} * (engineChunkCount - 1)
      : ${MOBILE_WEB_MERMAID_ENGINE_CHUNK_CHARACTERS};
    if (message.chunk.length !== expectedLength) return;
    var current = engineChunks[message.chunkIndex];
    if (typeof current === 'string' && current !== message.chunk) {
      removeEventListener('message', receiveEngine);
      post('error');
      return;
    }
    engineChunks[message.chunkIndex] = message.chunk;
    if (engineChunks.some(function (chunk) { return typeof chunk !== 'string'; })) return;
    var engine = engineChunks.join('');
    if (engine.length !== engineLength) return;
    removeEventListener('message', receiveEngine);
    post('assembled');
    run(engine, true);
  }

  var engineChunks = [];
  function receiveInitialization(event) {
    var message = event.data;
    if (
      event.source !== parent ||
      frameToken ||
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !hasExactKeys(message, 'channel,engineChunkCount,engineLength,source,token') ||
      message.channel !== '${MOBILE_WEB_MERMAID_FRAME_INIT_CHANNEL}' ||
      typeof message.token !== 'string' ||
      !/^[a-f0-9]{32}$/.test(message.token) ||
      typeof message.source !== 'string' ||
      message.source.length > ${MOBILE_WEB_MERMAID_MAX_SOURCE_CHARACTERS} ||
      !Number.isSafeInteger(message.engineLength) ||
      message.engineLength < 1 ||
      message.engineLength > ${MOBILE_WEB_MERMAID_MAX_ENGINE_CHARACTERS} ||
      !Number.isSafeInteger(message.engineChunkCount) ||
      message.engineChunkCount !==
        Math.ceil(message.engineLength / ${MOBILE_WEB_MERMAID_ENGINE_CHUNK_CHARACTERS})
    ) return;
    frameToken = message.token;
    diagramSource = message.source;
    engineLength = message.engineLength;
    engineChunkCount = message.engineChunkCount;
    engineChunks = new Array(engineChunkCount);
    removeEventListener('message', receiveInitialization);
    addEventListener('message', receiveEngine);
    post('ready');
  }

  var embeddedEngine = document.getElementById('engine').value;
  if (embeddedEngine) {
    frameToken = atob(document.getElementById('token').value);
    diagramSource = decodeUtf8(document.getElementById('source').value);
    engineLength = embeddedEngine.length;
    engineChunkCount = Math.ceil(engineLength / ${MOBILE_WEB_MERMAID_ENGINE_CHUNK_CHARACTERS});
    run(embeddedEngine, false);
  } else {
    addEventListener('message', receiveInitialization);
  }
})();`

export const MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH =
  "'sha256-JHwlo5V7HtwqexHUhXguW04dF71kAVlQOX1QdtyCkjg='"

export function mobileWebMermaidFrameCspDirectives() {
  return [
    "default-src 'none'",
    `script-src ${MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH} blob:`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'"
  ] as const
}

export function mobileWebMermaidFrameCsp(): string {
  return mobileWebMermaidFrameCspDirectives().join('; ')
}

type MermaidFrameTheme = {
  background: string
  primary: string
  text: string
  line: string
}

type MermaidFrameDocumentOptions = {
  theme: MermaidFrameTheme
  embeddedEngine?: string
  encodedSource?: string
  encodedToken?: string
}

export function buildMobileWebMermaidFrameDocument({
  theme,
  embeddedEngine = '',
  encodedSource = '',
  encodedToken = ''
}: MermaidFrameDocumentOptions): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
  <meta http-equiv="Content-Security-Policy" content="${mobileWebMermaidFrameCsp()}" />
  <style>:root{--diagram-background:${theme.background};--diagram-primary:${theme.primary};--diagram-text:${theme.text};--diagram-line:${theme.line}}html,body{box-sizing:border-box;margin:0;background:var(--diagram-background)}#c{padding:8px}#c svg{max-width:100%;height:auto}</style>
</head>
<body>
  <textarea id="engine" hidden>${embeddedEngine}</textarea>
  <textarea id="source" hidden>${encodedSource}</textarea>
  <textarea id="token" hidden>${encodedToken}</textarea>
  <div id="c"></div>
  <script>${MOBILE_WEB_MERMAID_FRAME_SCRIPT}</script>
</body>
</html>`
}
