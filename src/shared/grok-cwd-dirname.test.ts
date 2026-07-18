import { describe, expect, it } from 'vitest'
import {
  encodeGrokCwdDirName,
  encodeGrokUrlComponent,
  GROK_ENCODED_CWD_DIR_MAX_BYTES,
  grokCwdLeafName,
  slugifyGrokCwdLeaf
} from './grok-cwd-dirname'

describe('grok-cwd-dirname (xai-org/grok-build encode_cwd_dirname parity)', () => {
  it('URL-encodes short cwds like the urlencoding crate', () => {
    expect(encodeGrokCwdDirName('/tmp/work')).toBe('%2Ftmp%2Fwork')
    expect(encodeGrokUrlComponent('/a!b')).toBe('%2Fa%21b')
    expect(encodeGrokUrlComponent('/a*b')).toBe('%2Fa%2Ab')
    expect(encodeGrokUrlComponent("/a'b")).toBe('%2Fa%27b')
    expect(encodeGrokUrlComponent('/a(b)')).toBe('%2Fa%28b%29')
    // Unreserved `~` stays unescaped (matches Rust urlencoding).
    expect(encodeGrokUrlComponent('com~apple')).toBe('com~apple')
  })

  it('slugifies leaves like Grok slugify', () => {
    expect(slugifyGrokCwdLeaf('Hello World!', 40)).toBe('hello-world')
    expect(slugifyGrokCwdLeaf('深层目录', 40)).toBe('')
    expect(slugifyGrokCwdLeaf('a'.repeat(100), 10)).toBe('a'.repeat(10))
    expect(grokCwdLeafName('/Users/dev/main-branch')).toBe('main-branch')
    expect(grokCwdLeafName('C:\\Users\\dev\\my-app')).toBe('my-app')
  })

  it('uses slug-blake3 form when URL-encoded cwd exceeds 255 bytes', () => {
    const longAb = `/${'a'.repeat(200)}/${'b'.repeat(200)}`
    expect(Buffer.byteLength(encodeGrokUrlComponent(longAb), 'utf8')).toBeGreaterThan(
      GROK_ENCODED_CWD_DIR_MAX_BYTES
    )
    // Golden from xai-org/grok-build algorithm (Rust blake3 + slugify).
    expect(encodeGrokCwdDirName(longAb)).toBe(
      `${'b'.repeat(40)}-e22e6487078c7674`
    )
  })

  it('matches OSS golden vectors for long Unicode paths', () => {
    const vectors: Array<{ cwd: string; encoded: string }> = [
      {
        cwd: '/Users/dev/Documents/開発プロジェクト/機能追加/テスト環境/ソースコード/main-branch',
        encoded: 'main-branch-6aaeefdde2a621aa'
      },
      {
        cwd: '/Users/user/Library/Mobile Documents/com~apple~CloudDocs/项目文件/深层嵌套目录/更深层次的/工作区域/project',
        encoded: 'project-5a22eee5d15e14bd'
      },
      {
        cwd: '/Users/user/Documents/工作文件夹/二零二六年项目/子目录一/子目录二/子目录三/源代码/code',
        encoded: 'code-e5f13e136e4516ab'
      },
      {
        cwd: '/Users/user/Library/CloudStorage/OneDrive-대한민국회사/프로젝트/개발환경/소스코드/백엔드/서비스/my-app',
        encoded: 'my-app-00d240a68a30d482'
      }
    ]
    for (const { cwd, encoded } of vectors) {
      expect(Buffer.byteLength(encodeGrokUrlComponent(cwd), 'utf8')).toBeGreaterThan(
        GROK_ENCODED_CWD_DIR_MAX_BYTES
      )
      expect(encodeGrokCwdDirName(cwd)).toBe(encoded)
    }
  })

  it('returns null for empty cwd and rejects path-syntax components', () => {
    expect(encodeGrokCwdDirName('')).toBeNull()
    expect(encodeGrokCwdDirName('   ')).toBeNull()
    expect(encodeGrokCwdDirName('.')).toBeNull()
    expect(encodeGrokCwdDirName('..')).toBeNull()
  })
})
