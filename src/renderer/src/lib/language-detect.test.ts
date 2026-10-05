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

  it.each([
    'documents/report.typ',
    'C:\\documents\\REPORT.TYP',
    '\\\\server\\share\\report.typ',
    '/home/user/folder workspace/Report.TyP'
  ])('maps Typst source %s to the typst language id', (filePath) => {
    expect(detectLanguage(filePath)).toBe('typst')
  })

  it.each(['report.typ.bak', 'report.typx', 'documents.typ/README', 'documents.typ\\README'])(
    'keeps non-Typst file %s on plaintext',
    (filePath) => {
      expect(detectLanguage(filePath)).toBe('plaintext')
    }
  )

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

  it('maps Quarto and R Markdown files to the quarto language id', () => {
    expect(detectLanguage('slides/talk.qmd')).toBe('quarto')
    expect(detectLanguage('analysis/report.Rmd')).toBe('quarto')
    expect(detectLanguage('C:\\repo\\NOTES.QMD')).toBe('quarto')
    expect(detectLanguage('README.md')).toBe('markdown')
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

  it('maps .sol files to the Monaco built-in sol language id, not the solidity alias', () => {
    expect(detectLanguage('contracts/Vault.sol')).toBe('sol')
    expect(detectLanguage('C:\\repo\\contracts\\TOKEN.SOL')).toBe('sol')
  })

  it('maps Salesforce Apex sources to the apex language id (case-insensitive)', () => {
    expect(detectLanguage('force-app/main/default/classes/AccountService.cls')).toBe('apex')
    expect(detectLanguage('force-app/main/default/triggers/AccountTrigger.trigger')).toBe('apex')
    expect(detectLanguage('scripts/apex/seed.apex')).toBe('apex')
    expect(detectLanguage('C:\\repo\\force-app\\classes\\ACCOUNTSERVICE.CLS')).toBe('apex')
  })

  it('maps Ruby DSL extensions to the ruby language id (case-insensitive)', () => {
    expect(detectLanguage('lib/tasks/devise.rake')).toBe('ruby')
    expect(detectLanguage('config.ru')).toBe('ruby')
    expect(detectLanguage('app/views/posts/index.json.jbuilder')).toBe('ruby')
    expect(detectLanguage('lib/tasks/install.thor')).toBe('ruby')
    expect(detectLanguage('C:\\repo\\lib\\tasks\\DEVISE.RAKE')).toBe('ruby')
  })

  it('maps Ruby DSL filenames to the ruby language id', () => {
    expect(detectLanguage('rails/Guardfile')).toBe('ruby')
    expect(detectLanguage('deploy/Capfile')).toBe('ruby')
    expect(detectLanguage('ios/Podfile')).toBe('ruby')
    expect(detectLanguage('homebrew/Brewfile')).toBe('ruby')
    expect(detectLanguage('C:\\vms\\Vagrantfile')).toBe('ruby')
  })

  it('keeps near-miss Ruby DSL names off the ruby language id', () => {
    expect(detectLanguage('report.rake.bak')).toBe('plaintext')
    expect(detectLanguage('ruby.rakex')).toBe('plaintext')
  })

  it.each([
    'templates/base.twig',
    'templates/node--article.html.twig',
    'C:\\theme\\templates\\PAGE.HTML.TWIG',
    '\\\\server\\share\\templates\\PAGE.TWIG',
    '/home/user/folder workspace/templates/Base.TwIg'
  ])('maps Twig template %s to the Monaco built-in twig language id', (filePath) => {
    expect(detectLanguage(filePath)).toBe('twig')
  })

  it.each(['base.twig.bak', 'base.twigx', 'templates.twig/README', 'templates.twig\\README'])(
    'keeps non-Twig file %s on plaintext',
    (filePath) => {
      expect(detectLanguage(filePath)).toBe('plaintext')
    }
  )

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

  it.each([
    ['/Users/me/.zshrc', 'shell'],
    ['/home/me/.bashrc', 'shell'],
    ['C:\\Users\\me\\.bash_profile', 'shell'],
    ['/home/me/.bash_login', 'shell'],
    ['/home/me/.bash_logout', 'shell'],
    ['/home/me/.profile', 'shell'],
    ['/home/me/.zshenv', 'shell'],
    ['/home/me/.zprofile', 'shell'],
    ['/home/me/.zlogin', 'shell'],
    ['/home/me/.zlogout', 'shell']
  ])('maps shell startup dotfiles to shell: %s', (filePath, expected) => {
    expect(detectLanguage(filePath)).toBe(expected)
  })

  it.each([
    ['/Users/me/.ZSHRC', 'shell'],
    ['C:\\Users\\me\\.BASHRC', 'shell'],
    ['/home/me/.Bash_Profile', 'shell'],
    ['/home/me/.PROFILE', 'shell'],
    ['/home/me/.ZPROFILE', 'shell'],
    ['C:\\repo\\DOCKERFILE', 'dockerfile'],
    ['C:\\repo\\dockerfile', 'dockerfile'],
    ['C:\\repo\\MAKEFILE', 'makefile'],
    ['C:\\repo\\makefile', 'makefile'],
    ['C:\\repo\\CMAKELISTS.TXT', 'cmake'],
    ['C:\\repo\\.GITIGNORE', 'ini']
  ])('maps exact filenames case-insensitively: %s', (filePath, expected) => {
    expect(detectLanguage(filePath)).toBe(expected)
  })
})
