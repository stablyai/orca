import { describe, expect, it } from 'vitest'
import { detectLanguage } from './language-detect'

describe('detectLanguage', () => {
  it('maps .vue files to the custom vue language id', () => {
    expect(detectLanguage('src/components/App.vue')).toBe('vue')
  })

  it('maps .svelte files to the custom svelte language id', () => {
    expect(detectLanguage('src/components/Widget.svelte')).toBe('svelte')
  })

  it('maps .astro files to the custom astro language id', () => {
    expect(detectLanguage('src/routes/index.astro')).toBe('astro')
  })

  it('maps Nim files to the nim language id', () => {
    expect(detectLanguage('src/main.nim')).toBe('nim')
    expect(detectLanguage('tasks/build.nims')).toBe('nim')
    expect(detectLanguage('packages/app.nimble')).toBe('nim')
  })

  it('maps exact filenames from Windows paths', () => {
    expect(detectLanguage('C:\\Users\\alice\\repo\\Dockerfile')).toBe('dockerfile')
    expect(detectLanguage('C:\\Users\\alice\\repo\\CMakeLists.txt')).toBe('cmake')
  })

  it('maps Windows Batch files to Monaco built-in Batch language id', () => {
    expect(detectLanguage('scripts/setup.bat')).toBe('bat')
    expect(detectLanguage('C:\\repo\\scripts\\bootstrap.CMD')).toBe('bat')
  })

  it('maps SystemVerilog and Verilog files to their Monaco language ids', () => {
    expect(detectLanguage('rtl/cpu.sv')).toBe('systemverilog')
    expect(detectLanguage('rtl/pkg.svh')).toBe('systemverilog')
    expect(detectLanguage('rtl/alu.v')).toBe('verilog')
    expect(detectLanguage('rtl/defs.vh')).toBe('verilog')
    expect(detectLanguage('C:\\rtl\\TOP.SV')).toBe('systemverilog')
  })

  it.each([
    'report.abap',
    'src/zcor0260.prog.abap',
    'src/zcl_demo.clas.abap',
    'src/zif_demo.intf.abap',
    'C:\\repo\\src\\ZCL_DEMO.CLAS.ABAP',
    '\\\\server\\share\\src\\ZREPORT.PROG.ABAP',
    '/home/user/folder workspace/src/Report.AbAp'
  ])('maps ABAP source %s to the Monaco built-in abap language id', (filePath) => {
    expect(detectLanguage(filePath)).toBe('abap')
  })

  it.each(['src.abap/README', 'src\\abap.abap\\README', 'report.abap.bak', 'report.abapx'])(
    'keeps non-ABAP file %s on plaintext',
    (filePath) => {
      expect(detectLanguage(filePath)).toBe('plaintext')
    }
  )

  it('maps .proto files to the Monaco built-in proto language id, not the alias', () => {
    expect(detectLanguage('api/v1/service.proto')).toBe('proto')
  })

  it('maps .jsonl files to the dedicated jsonl language id (case-insensitive)', () => {
    expect(detectLanguage('/home/user/.claude/sessions/transcript.jsonl')).toBe('jsonl')
    expect(detectLanguage('C:\\Users\\alice\\.codex\\LOG.JSONL')).toBe('jsonl')
  })

  it('maps .cts/.mts files to the Monaco built-in typescript language id (case-insensitive)', () => {
    expect(detectLanguage('config/vitest.config.mts')).toBe('typescript')
    expect(detectLanguage('scripts/postinstall.cts')).toBe('typescript')
    expect(detectLanguage('types/global.d.mts')).toBe('typescript')
    expect(detectLanguage('C:\\repo\\config\\BUILD.MTS')).toBe('typescript')
  })

  it('keeps .mjs/.cjs on the Monaco built-in javascript language id', () => {
    expect(detectLanguage('scripts/build.mjs')).toBe('javascript')
    expect(detectLanguage('scripts/legacy.cjs')).toBe('javascript')
  })

  it('maps .r files to the r language id regardless of case', () => {
    expect(detectLanguage('analysis/model.r')).toBe('r')
    expect(detectLanguage('analysis/MODEL.R')).toBe('r')
  })

  it('maps .jsp/.jspf files to the built-in html language id (case-insensitive)', () => {
    expect(detectLanguage('src/main/webapp/index.jsp')).toBe('html')
    expect(detectLanguage('src/main/webapp/WEB-INF/include/header.jspf')).toBe('html')
    expect(detectLanguage('C:\\app\\WebContent\\WEB-INF\\jsp\\LIST.JSP')).toBe('html')
  })

  it('maps .liquid files to the Monaco built-in liquid language id, including the compound .html.liquid form', () => {
    expect(detectLanguage('theme.liquid')).toBe('liquid')
    expect(detectLanguage('sections/header.liquid')).toBe('liquid')
    expect(detectLanguage('templates/product.html.liquid')).toBe('liquid')
    expect(detectLanguage('C:\\theme\\snippets\\CART.LIQUID')).toBe('liquid')
  })

  it('maps Salesforce Apex sources to the apex language id (case-insensitive)', () => {
    expect(detectLanguage('force-app/main/default/classes/AccountService.cls')).toBe('apex')
    expect(detectLanguage('force-app/main/default/triggers/AccountTrigger.trigger')).toBe('apex')
    expect(detectLanguage('scripts/apex/seed.apex')).toBe('apex')
    expect(detectLanguage('C:\\repo\\force-app\\classes\\ACCOUNTSERVICE.CLS')).toBe('apex')
  })

  it('maps .twig files to the Monaco built-in twig language id, including the compound .html.twig form', () => {
    expect(detectLanguage('templates/base.twig')).toBe('twig')
    expect(detectLanguage('templates/node--article.html.twig')).toBe('twig')
    expect(detectLanguage('C:\\theme\\templates\\PAGE.HTML.TWIG')).toBe('twig')
  })

  it('keeps .json/.jsonc on the built-in json language and unknown on plaintext', () => {
    expect(detectLanguage('config/settings.json')).toBe('json')
    expect(detectLanguage('config/tsconfig.jsonc')).toBe('json')
    expect(detectLanguage('notes/scratch.unknownext')).toBe('plaintext')
  })
  it.each([
    ['.env', 'ini'],
    ['.env.local', 'ini'],
    ['.env.development', 'ini'],
    ['.env.production', 'ini'],
    ['.env.functions.local', 'ini'],
    ['.env.staging', 'ini'],
    ['.env.test.example', 'ini'],
    ['config/.env.development.local', 'ini'],
    ['.ENV', 'ini'],
    ['.ENV.STAGING', 'ini'],
    ['C:\\repo\\.EnV.FUNCTIONS.LOCAL', 'ini'],
    ['\\\\server\\share\\.env.test.example', 'ini'],
    ['.env.sh', 'shell'],
    ['.ENV.SH', 'shell'],
    ['.env.json', 'json'],
    ['.env.local.ts', 'typescript'],
    ['.env/CMakeLists.txt', 'cmake'],
    ['C:\\repo\\.env.local\\Dockerfile', 'dockerfile'],
    ['.envrc', 'plaintext'],
    ['.environment', 'plaintext'],
    ['env.staging', 'plaintext'],
    ['dev.env', 'plaintext'],
    ['other.env.local', 'plaintext'],
    ['..env.local', 'plaintext'],
    ['.env.staging/readme', 'plaintext'],
    ['C:\\repo\\.env.local\\notes', 'plaintext'],
    ['', 'plaintext']
  ])('detects dotenv names without overriding specific mappings: %s', (filePath, expected) => {
    expect(detectLanguage(filePath)).toBe(expected)
  })
})
