import { describe, expect, it } from 'vitest'
import { isGeneratedCodePath } from './generated-code-path'

describe('isGeneratedCodePath', () => {
  it('recognizes dependency lockfiles across ecosystems', () => {
    for (const filePath of [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'Cargo.lock',
      'poetry.lock',
      'uv.lock',
      'Gemfile.lock',
      'composer.lock',
      'go.sum',
      'flake.lock',
      'mobile/pubspec.lock',
      'services/api/Pipfile.lock'
    ]) {
      expect(isGeneratedCodePath(filePath), filePath).toBe(true)
    }
  })

  it('recognizes tool-stamped filename suffixes', () => {
    for (const filePath of [
      'api/service.pb.go',
      // grpc-gateway / protoc-gen-validate stack extra segments onto `.pb.`
      'api/service.pb.gw.go',
      'api/service.pb.validate.go',
      'api/service_pb2.py',
      'api/service_pb2_grpc.py',
      'src/schema.gen.ts',
      'internal/bindings_generated.go',
      'src/Api.generated.ts',
      'Forms/Main.Designer.cs',
      'lib/model.g.dart',
      'lib/model.freezed.dart',
      'public/app.min.js',
      'public/app.js.map',
      'src/components/__snapshots__/Chip.tsx.snap'
    ]) {
      expect(isGeneratedCodePath(filePath), filePath).toBe(true)
    }
  })

  it('recognizes generated directories on either separator', () => {
    expect(isGeneratedCodePath('dist/renderer/index.js')).toBe(true)
    expect(isGeneratedCodePath('src/__generated__/schema.ts')).toBe(true)
    expect(isGeneratedCodePath('vendor/github.com/pkg/errors/errors.go')).toBe(true)
    expect(isGeneratedCodePath('src\\__pycache__\\mod.pyc')).toBe(true)
  })

  it('leaves hand-written paths alone, including the ambiguous directory names', () => {
    for (const filePath of [
      'src/shared/git-branch-line-total.ts',
      // Excluded on purpose: all common as authored source directories.
      'build/scripts/release.ts',
      'target/tracker.rs',
      'src/out/renderer.ts',
      'cmd/bin/main.go',
      // Substrings, not whole segments or suffixes.
      'src/distributed/queue.ts',
      'src/vendors/stripe.ts',
      'src/generator/emit.ts',
      'docs/generated-code-policy.md',
      'src/shared/generated-code-path.ts'
    ]) {
      expect(isGeneratedCodePath(filePath), filePath).toBe(false)
    }
  })
})
